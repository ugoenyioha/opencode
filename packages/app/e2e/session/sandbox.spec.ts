import fs from "node:fs/promises"
import path from "node:path"
import { test, expect } from "../fixtures"
import { cleanupTestProject, createTestProject, seedProjects, withSession } from "../actions"
import { promptSelector } from "../selectors"
import { createSdk, sessionPath } from "../utils"

const seedSystem = [
  "You are seeding deterministic e2e UI state.",
  "Follow the user's instruction exactly.",
  "When asked to call a tool, call exactly that tool exactly once with the exact JSON input.",
  "Do not call any extra tools.",
].join(" ")

async function seedStorage(page: Parameters<typeof seedProjects>[0], directory: string) {
  await seedProjects(page, { directory })
  await page.addInitScript(() => {
    localStorage.setItem(
      "opencode.global.dat:model",
      JSON.stringify({
        recent: [{ providerID: "opencode", modelID: "big-pickle" }],
        user: [],
        variant: {},
      }),
    )
  })
}

async function openSession(page: Parameters<typeof seedProjects>[0], url: string) {
  for (let i = 0; i < 3; i++) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => undefined)
    const prompt = page.locator(promptSelector)
    const visible = await prompt
      .isVisible()
      .then((x) => x)
      .catch(() => false)
    if (visible) return

    const restart = page.getByRole("button", { name: "Restart" }).first()
    const failed = await restart
      .isVisible()
      .then((x) => x)
      .catch(() => false)
    if (failed) {
      await restart.click().catch(() => undefined)
      await page.waitForTimeout(300)
      continue
    }

    await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => undefined)
  }

  await expect(page.locator(promptSelector)).toBeVisible({ timeout: 15_000 })
}

async function setupProject(page: Parameters<typeof seedProjects>[0], config: Record<string, unknown>) {
  const directory = await createTestProject()
  await fs.writeFile(path.join(directory, "opencode.json"), JSON.stringify(config, null, 2))
  await seedStorage(page, directory)

  const sdk = createSdk(directory)
  const gotoSession = async (sessionID?: string) => {
    await openSession(page, sessionPath(directory, sessionID))
  }

  return { directory, sdk, gotoSession }
}

async function expectWebfetchBlocked(input: { sdk: ReturnType<typeof createSdk>; sessionID: string; agent?: string }) {
  const prompt = [
    "Your only valid response is one webfetch tool call.",
    `Use this JSON input: ${JSON.stringify({ url: "https://example.com", format: "text" })}`,
    "Do not output plain text.",
  ].join("\n")

  await input.sdk.session.promptAsync({
    sessionID: input.sessionID,
    agent: input.agent,
    system: seedSystem,
    parts: [{ type: "text", text: prompt }],
  })

  await expect
    .poll(
      async () => {
        const messages = await input.sdk.session.messages({ sessionID: input.sessionID, limit: 100 })
        const parts = (messages.data ?? []).flatMap((message) => message.parts ?? [])
        const webfetch = parts.filter((part) => part.type === "tool" && part.tool === "webfetch").at(-1)
        if (!webfetch || webfetch.type !== "tool") return undefined
        if (webfetch.state?.status === "error") return webfetch.state.error
        if (webfetch.state?.status === "completed") return "completed"
        return undefined
      },
      { timeout: 60_000, intervals: [250, 500, 1_000] },
    )
    .toContain("Network access is blocked")
}

test("webfetch is blocked when sandbox network is false", async ({ page }) => {
  test.setTimeout(120_000)

  const config = {
    permission: { webfetch: "allow" },
    sandbox: { bash: "namespace", network: false },
  }

  const project = await setupProject(page, config)
  try {
    await withSession(project.sdk, `e2e sandbox network false ${Date.now()}`, async (session) => {
      await project.gotoSession(session.id)
      await expectWebfetchBlocked({ sdk: project.sdk, sessionID: session.id })
    })
  } finally {
    await cleanupTestProject(project.directory)
  }
})

test("agent network false blocks webfetch even when global allows", async ({ page }) => {
  test.setTimeout(120_000)

  const config = {
    permission: { webfetch: "allow" },
    sandbox: { bash: "namespace", network: true },
    agent: {
      build: {
        sandbox: { network: false },
      },
    },
  }

  const project = await setupProject(page, config)
  try {
    await withSession(project.sdk, `e2e sandbox agent deny ${Date.now()}`, async (session) => {
      await project.gotoSession(session.id)
      await expectWebfetchBlocked({ sdk: project.sdk, sessionID: session.id, agent: "build" })
    })
  } finally {
    await cleanupTestProject(project.directory)
  }
})

test("agent network true cannot override global deny", async ({ page }) => {
  test.setTimeout(120_000)

  const config = {
    permission: { webfetch: "allow" },
    sandbox: { bash: "namespace", network: false },
    agent: {
      build: {
        sandbox: { network: true },
      },
    },
  }

  const project = await setupProject(page, config)
  try {
    await withSession(project.sdk, `e2e sandbox global deny ${Date.now()}`, async (session) => {
      await project.gotoSession(session.id)
      await expectWebfetchBlocked({ sdk: project.sdk, sessionID: session.id, agent: "build" })
    })
  } finally {
    await cleanupTestProject(project.directory)
  }
})
