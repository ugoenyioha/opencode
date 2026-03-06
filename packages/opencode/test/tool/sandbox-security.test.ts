import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from "bun:test"
import path from "path"
import { BashTool } from "../../src/tool/bash"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Sandbox } from "../../src/sandbox"

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

const backend = Sandbox.available()
const hasSandbox = backend !== "none"
// Darwin sandbox-exec currently allows file-read*, only bwrap truly restricts reads
const supportsFilesystemIsolation = backend === "bwrap"
const curlBinary = Bun.which("curl")

async function runBash(
  directory: string,
  params: { command: string; description: string; timeout?: number; unsafe?: boolean },
) {
  return Instance.provide({
    directory,
    fn: async () => {
      const bash = await BashTool.init()
      return bash.execute(params, ctx)
    },
  })
}

describe("sandbox security hardening", () => {
  let originalHardened: string | undefined

  beforeEach(() => {
    originalHardened = process.env.OPENCODE_HARDENED_MODE
    process.env.OPENCODE_HARDENED_MODE = "true"
  })

  afterEach(() => {
    if (originalHardened !== undefined) {
      process.env.OPENCODE_HARDENED_MODE = originalHardened
    } else {
      delete process.env.OPENCODE_HARDENED_MODE
    }
  })

  if (!hasSandbox) {
    test.skip(`bash sandbox unavailable on ${process.platform}`, () => {})
    return
  }

  if (!supportsFilesystemIsolation) {
    test.skip("blocks filesystem escape outside workspace (requires bwrap or sandbox-exec)", () => {})
  } else {
    test("blocks filesystem escape outside workspace", async () => {
      await using secret = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "secret.txt"), "classified sandbox secret")
        },
      })

      await using project = await tmpdir({
        git: true,
        config: {
          sandbox: {
            bash: "auto",
            network: false,
          },
        },
      })

      const target = path.join(secret.path, "secret.txt")
      const result = await runBash(project.path, {
        command: `cat ${target}`,
        description: "Attempt to read outside workspace",
      })

      expect(result.metadata.exit).not.toBe(0)
      expect(result.output).not.toContain("classified sandbox secret")
    })
  }

  if (!curlBinary) {
    test.skip("blocks outbound network with sandbox.network=false (requires curl binary)", () => {})
  } else {
    test("blocks outbound network with sandbox.network=false", async () => {
      const server = Bun.serve({
        port: 0,
        fetch() {
          return new Response("sandbox-ok", { headers: { "content-type": "text/plain" } })
        },
      })

      try {
        const url = `http://127.0.0.1:${server.port}/ping`
        const baseline = await fetch(url)
        expect(await baseline.text()).toBe("sandbox-ok")

        await using allowed = await tmpdir({
          git: true,
          config: {
            sandbox: {
              bash: "auto",
              network: true,
            },
          },
        })

        const success = await runBash(allowed.path, {
          command: `"${curlBinary}" --max-time 2 --silent --show-error ${url}`,
          description: "Network probe with sandbox network enabled",
        })
        const enabledPassed = success.metadata.exit === 0 && success.output.includes("sandbox-ok")

        await using blocked = await tmpdir({
          git: true,
          config: {
            sandbox: {
              bash: "auto",
              network: false,
            },
          },
        })

        const blockedResult = await runBash(blocked.path, {
          command: `"${curlBinary}" --max-time 2 --silent --show-error ${url}`,
          description: "Network probe with sandbox network disabled",
        })

        expect(blockedResult.output).not.toContain("sandbox-ok")
        expect(enabledPassed || blockedResult.metadata.exit !== 0).toBe(true)
      } finally {
        server.stop()
      }
    })
  }

  test("terminates abusive workloads via timeout policy", async () => {
    await using project = await tmpdir({
      git: true,
      config: {
        sandbox: {
          bash: "auto",
          network: false,
        },
      },
    })

    const result = await runBash(project.path, {
      command: "while true; do :; done",
      description: "Spin CPU to trigger timeout",
      timeout: 250,
      unsafe: true,
    })

    expect(
      result.metadata.exit === null || result.metadata.exit !== 0 || result.output.includes("exceeding timeout"),
    ).toBe(true)
  })
})
