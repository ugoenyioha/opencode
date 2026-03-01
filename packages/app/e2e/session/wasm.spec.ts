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

test("wasm plugin executes correctly in E2E environment", async ({ page }) => {
  test.setTimeout(120_000)

  const directory = await createTestProject()

  // Create a .opencode/tools directory
  const toolsDir = path.join(directory, ".opencode", "tools")
  await fs.mkdir(toolsDir, { recursive: true })

  // Copy the fixture WASM plugin into the project
  const sourceWasm = path.resolve(process.cwd(), "..", "opencode", "test", "fixtures", "wasm", "echo.wasm")
  const targetWasm = path.join(toolsDir, "echo.wasm")
  await fs.copyFile(sourceWasm, targetWasm)

  const sourceMeta = path.resolve(process.cwd(), "..", "opencode", "test", "fixtures", "wasm", "echo.wasm.json")
  const targetMeta = path.join(toolsDir, "echo.wasm.json")
  await fs.copyFile(sourceMeta, targetMeta)

  // Create the config enabling the WASM sandbox and the tool
  const config = {
    sandbox: {
      wasm: { enabled: true },
    },
    permission: { echo: "allow" },
  }
  await fs.writeFile(path.join(directory, ".opencode", "opencode.json"), JSON.stringify(config, null, 2))

  // Wait for the backend file watcher to pick up the new config and register the tool
  await new Promise((resolve) => setTimeout(resolve, 1000))

  await seedStorage(page, directory)
  const sdk = createSdk(directory)

  try {
    await withSession(
      sdk,
      `e2e wasm ${Date.now()}`,
      async (session) => {
        await openSession(page, sessionPath(directory, session.id))

        const prompt = [
          "Your only valid response is one tool call for the custom plugin tool named 'echo'.",
          "DO NOT USE THE 'bash' TOOL.",
          `Use this JSON input: ${JSON.stringify({ text: "hello from WASM!" })}`,
          "Do not output plain text.",
        ].join("\n")

        await sdk.session.promptAsync({
          sessionID: session.id,
          system: seedSystem,
          parts: [{ type: "text", text: prompt }],
        })

        // The echo plugin takes { text: "..." } and returns { text: "...", from_wasm: true }
        await expect
          .poll(
            async () => {
              const messages = await sdk.session.messages({ sessionID: session.id, limit: 100 })
              const parts = (messages.data ?? []).flatMap((message) => message.parts ?? [])
              const toolCall = parts.filter((part) => part.type === "tool" && part.tool === "echo").at(-1)

              if (!toolCall || toolCall.type !== "tool") {
                if (messages.data && messages.data.length > 1) {
                  console.log("Messages so far:", JSON.stringify(messages.data, null, 2))
                }
                return undefined
              }
              if (toolCall.state?.status === "error") return "error: " + toolCall.state.error
              if (toolCall.state?.status === "completed") return JSON.stringify(toolCall.state.output)
              return undefined
            },
            { timeout: 30_000, intervals: [250, 500, 1_000] },
          )
          .toContain("hello from WASM!")
      },
      [{ permission: "echo", action: "allow", pattern: "*" }],
    )
  } finally {
    await cleanupTestProject(directory)
  }
})
