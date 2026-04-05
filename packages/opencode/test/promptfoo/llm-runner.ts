import os from "node:os"
import path from "node:path"
import fs from "node:fs/promises"

// Create isolated XDG environment
const dir = path.join(os.tmpdir(), "opencode-llm-eval-" + process.pid)
await fs.mkdir(dir, { recursive: true })

const dataHome = path.join(dir, "share")
const cacheHome = path.join(dir, "cache")
const configHome = path.join(dir, "config")
const stateHome = path.join(dir, "state")

process.env["XDG_DATA_HOME"] = dataHome
process.env["XDG_CACHE_HOME"] = cacheHome
process.env["XDG_CONFIG_HOME"] = configHome
process.env["XDG_STATE_HOME"] = stateHome
process.env["OPENCODE_TEST_HOME"] = path.join(dir, "home")
process.env["OPENCODE_TEST_MANAGED_CONFIG_DIR"] = path.join(dir, "managed")
process.env["NODE_ENV"] = "test"
// Prevent models.dev fetch during test
process.env["OPENCODE_DISABLE_MODELS_FETCH"] = "true"

// Copy the host's auth.json into the isolated data directory so the
// test agent inherits the user's existing Claude/OpenAI/Gemini subscriptions.
// We hardcode the known host path since XDG vars are already overridden above.
async function syncAuth() {
  const hostAuthPath = path.join(os.homedir(), ".local", "share", "opencode", "auth.json")
  const destDir = path.join(dataHome, "opencode")
  await fs.mkdir(destDir, { recursive: true })
  try {
    await fs.copyFile(hostAuthPath, path.join(destDir, "auth.json"))
    // Preserve permissions (auth.json is 0600)
    await fs.chmod(path.join(destDir, "auth.json"), 0o600)
  } catch (e: any) {
    console.error(`[llm-runner] WARNING: Could not copy auth.json from ${hostAuthPath}: ${e.message}`)
    console.error("[llm-runner] LLM calls will likely fail without authentication.")
  }
}

await syncAuth()

import { tmpdir, trustWorkspace } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Plugin } from "../../src/plugin"
import { Session } from "../../src/session"
import { Server } from "../../src/server/server"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { PermissionNext } from "../../src/permission/next"


import { Log } from "../../src/util/log"
Log.init({ print: false })

// Usage: bun run llm-runner.ts <model> <query> [timeout_ms]
//
// Sends <query> to the specified <model> via the OpenCode SDK in a headless
// session with hardened sandbox enabled. Captures all tool calls and text
// responses. Returns a combined output string for promptfoo assertion matching.
//
// The session auto-approves all permissions (permission: { "*": "allow" })
// to ensure we test the Sandbox (Gate 5), not the Permission layer (Gate 2).

async function main() {
  const model = process.argv[2] || ""
  const query = process.argv[3] || ""
  const timeout = parseInt(process.argv[4] || "60000", 10)

  if (!model || !query) {
    console.error("Usage: bun run llm-runner.ts <provider/model> <query> [timeout_ms]")
    process.exit(1)
  }

  // Include the external Anthropic OAuth plugin from the host config so
  // Claude Max subscriptions work. Falls back gracefully if not present.
  const anthropicPlugin = "file:///Users/uenyioha/tmp/opencode-anthropic-auth-gitea"
  const fs = await import("node:fs/promises")
  const hasAnthropicPlugin = await fs.access(anthropicPlugin.replace("file://", "")).then(() => true).catch(() => false)

  await using tmp = await tmpdir({
    trust: false, // we'll trust manually after writing config
    config: {
      hardened: true,
      sandbox: {
        bash: "auto",
        network: false,
      },
      ...(hasAnthropicPlugin ? { plugin: [anthropicPlugin] } : {}),
    },
  })
  // Trust the workspace so hardened mode allows the external auth plugin
  await trustWorkspace(tmp.path)

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Plugin.init()

      // Create an in-process SDK client (no HTTP server needed)
      const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        return Server.App().fetch(request)
      }) as typeof globalThis.fetch

      const sdk = createOpencodeClient({
        baseUrl: "http://opencode.internal",
        directory: Instance.directory,
        fetch: fetchFn,
      })

      // Auto-approve all permissions to bypass TUI interaction.
      // This deliberately tests the Sandbox (Gate 5) as the last line of defense.
      const rules: PermissionNext.Ruleset = [
        { permission: "question", action: "deny", pattern: "*" },
        { permission: "plan_enter", action: "deny", pattern: "*" },
        { permission: "plan_exit", action: "deny", pattern: "*" },
      ]

      const sessionRes = await sdk.session.create({
        title: `redteam-eval-${Date.now()}`,
        permission: rules,
      })
      const sessionID = sessionRes.data?.id
      if (!sessionID) {
        console.error("[llm-runner] Failed to create session")
        process.exit(1)
      }

      // Subscribe to events before sending the prompt
      const events = await sdk.event.subscribe()
      const output: string[] = []
      let done = false

      const timer = setTimeout(() => {
        if (!done) {
          output.push("[TIMEOUT] LLM did not complete within " + timeout + "ms")
          done = true
        }
      }, timeout)

      // Start event loop
      const loopPromise = (async () => {
        for await (const event of events.stream) {
          if (done) break

          if (event.type === "message.part.updated") {
            const part = event.properties.part
            if (part.sessionID !== sessionID) continue

            // Capture tool calls
            if (part.type === "tool" && (part.state.status === "completed" || part.state.status === "error")) {
              const state = part.state
              const input = "input" in state ? JSON.stringify(state.input) : ""
              const result = state.status === "completed" && "output" in state ? state.output : ""
              const error = state.status === "error" && "error" in state ? state.error : ""
              output.push(`[TOOL:${part.tool}] input=${input} output=${result || error}`)
            }

            // Capture text responses
            if (part.type === "text" && part.time?.end) {
              output.push(`[TEXT] ${part.text}`)
            }
          }

          if (event.type === "session.error") {
            const props = event.properties
            if (props.sessionID !== sessionID) continue
            const err =
              props.error && "data" in props.error && props.error.data && "message" in props.error.data
                ? String(props.error.data.message)
                : String(props.error?.name || "unknown error")
            output.push(`[ERROR] ${err}`)
          }

          // Permission requests: auto-allow everything (we're testing the sandbox, not permissions)
          if (event.type === "permission.asked") {
            const perm = event.properties
            if (perm.sessionID !== sessionID) continue
            output.push(`[PERMISSION] ${perm.permission} ${perm.patterns.join(",")} -> auto-allow`)
            await sdk.permission.reply({ requestID: perm.id, reply: "always" })
          }

          if (
            event.type === "session.status" &&
            event.properties.sessionID === sessionID &&
            event.properties.status.type === "idle"
          ) {
            break
          }
        }
      })()

      // Parse model string (e.g., "anthropic/claude-3-7-sonnet-latest")
      const [providerID, ...modelParts] = model.split("/")
      const modelID = modelParts.join("/")

      // Send the adversarial prompt
      await sdk.session.prompt({
        sessionID,
        model: { providerID, modelID },
        parts: [{ type: "text", text: query }],
      })

      // Wait for completion or timeout
      await loopPromise.catch(() => {})
      done = true
      clearTimeout(timer)

      console.log(output.join("\n"))
      process.exit(0)
    },
  })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
