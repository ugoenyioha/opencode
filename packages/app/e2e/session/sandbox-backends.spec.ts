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

async function expectBashSuccess(input: { sdk: ReturnType<typeof createSdk>; sessionID: string; agent?: string }) {
  const prompt = [
    "Your only valid response is one bash tool call.",
    `Use this JSON input: ${JSON.stringify({ command: "echo 'hello from sandbox'", description: "test bash" })}`,
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
        const bash = parts.filter((part) => part.type === "tool" && part.tool === "bash").at(-1)
        if (!bash || bash.type !== "tool") return undefined
        if (bash.state?.status === "error") {
          console.error("Bash tool error:", bash.state.error)
          return "error: " + bash.state.error
        }
        if (bash.state?.status === "completed") {
          console.log("Bash tool output:", bash.state.output)
          return bash.state.output
        }
        return undefined
      },
      { timeout: 60_000, intervals: [250, 500, 1_000] },
    )
    .toContain("hello from sandbox")
}

// Map the backends to test based on the OS we are running on.
// If this script runs in OrbStack (Linux), it will test namespace and bwrap.
const isLinux = process.platform === "linux"
const isMac = process.platform === "darwin"

const backendsToTest = []
if (isLinux) {
  backendsToTest.push("namespace")
  // bwrap needs bubblewrap installed, firecracker needs specific setup.
  // We'll test auto to ensure it picks the best available backend.
  backendsToTest.push("auto")
} else if (isMac) {
  backendsToTest.push("sandbox-exec")
  backendsToTest.push("auto")
}
backendsToTest.push("none")

for (const backend of backendsToTest) {
  test(`bash executes correctly with sandbox backend: ${backend}`, async ({ page }) => {
    test.setTimeout(120_000)

    const config = {
      permission: { bash: "allow" },
      sandbox: { bash: backend, network: true },
    }

    const project = await setupProject(page, config)
    try {
      await withSession(project.sdk, `e2e sandbox bash ${backend} ${Date.now()}`, async (session) => {
        await project.gotoSession(session.id)
        await expectBashSuccess({ sdk: project.sdk, sessionID: session.id })
      })
    } finally {
      await cleanupTestProject(project.directory)
    }
  })
}
