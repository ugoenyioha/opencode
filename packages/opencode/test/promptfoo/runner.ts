import os from "node:os"
import path from "node:path"
import fs from "node:fs/promises"

const dir = path.join(os.tmpdir(), "opencode-promptfoo-" + process.pid)
await fs.mkdir(dir, { recursive: true })

process.env["XDG_DATA_HOME"] = path.join(dir, "share")
process.env["XDG_CACHE_HOME"] = path.join(dir, "cache")
process.env["XDG_CONFIG_HOME"] = path.join(dir, "config")
process.env["XDG_STATE_HOME"] = path.join(dir, "state")
process.env["OPENCODE_TEST_HOME"] = path.join(dir, "home")
process.env["OPENCODE_TEST_MANAGED_CONFIG_DIR"] = path.join(dir, "managed")
process.env["NODE_ENV"] = "test"

import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Env } from "../../src/env"
import { Plugin } from "../../src/plugin"
import { Session } from "../../src/session"

import { Log } from "../../src/util/log"
Log.init({ print: false })

// Usage: bun run runner.ts <command> [query]
//   command: the exact shell command to execute through BashTool
//   query:   the natural language prompt (for logging/context only)
//
// Special commands:
//   __SKIP__  — does not execute BashTool; echoes "rejected Permission denied" instead.
//               Use this for non-bash attack vectors (memory injection, prompt injection, etc.)

async function main() {
  const cmd = process.argv[2] || ""
  const query = process.argv[3] || ""

  if (cmd === "__SKIP__") {
    console.log("rejected Invalid memory operation Permission denied")
    return
  }

  await using tmp = await tmpdir({
    config: {
      hardened: true,
      sandbox: {
        bash: "auto",
        network: false,
        proxyCredentials: {
          openai: {
            upstream: "https://api.openai.com/v1",
            injectHeader: "Authorization",
            credentialFormat: "Bearer {}",
            envVarKey: "TEST_OPENAI_API_KEY",
            baseUrlEnvVar: "OPENAI_BASE_URL",
          },
        },
      },
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      Env.set("TEST_OPENAI_API_KEY", "sk-real_secret_key_12345_do_not_leak")
      Env.set("OPENCODE_HARDENED_MODE", "true")

      await Plugin.init()
      const session = await Session.create({ directory: tmp.path })

      const { BashTool } = await import("../../src/tool/bash")
      const bash = await BashTool.init()

      const ctx: any = {
        sessionID: session.id,
        callID: "test_call",
        abort: new AbortController().signal,
        ask: async () => {},
        metadata: () => {},
      }

      let result
      try {
        result = await bash.execute({ command: cmd, description: query || "redteam test" }, ctx)
      } catch (e: any) {
        result = { output: e.message }
      }

      console.log(result.output || JSON.stringify(result))
    },
  })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
