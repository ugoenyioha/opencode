import { describe, expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { ToolRegistry } from "../../src/tool/registry"
import { WasmSandbox } from "../../src/sandbox/wasm"

const WASM_FIXTURE = path.join(import.meta.dir, "..", "fixtures", "wasm", "echo.wasm")
const WASM_META_FIXTURE = path.join(import.meta.dir, "..", "fixtures", "wasm", "echo.wasm.json")

const ctx = {
  sessionID: "test",
  messageID: "test",
  callID: "test",
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata() {},
  ask: async () => {},
}

describe("wasm tool registry", () => {
  test("discovers wasm tool, parses metadata, and routes execution", async () => {
    const call = spyOn(WasmSandbox, "call").mockResolvedValue("ok-from-wasm")
    try {
      await using tmp = await tmpdir({
        config: {
          sandbox: {
            wasm: {
              enabled: true,
              timeout_ms: 1234,
              memory_pages: 32,
              network: false,
              allowed_hosts: ["example.com"],
              allowed_paths: ["."],
            },
          },
        },
        init: async (dir) => {
          const tools = path.join(dir, ".opencode", "tools")
          await fs.mkdir(tools, { recursive: true })
          await Bun.write(path.join(tools, "echo.wasm"), Bun.file(WASM_FIXTURE))
          await Bun.write(path.join(tools, "echo.wasm.json"), Bun.file(WASM_META_FIXTURE))
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const ids = await ToolRegistry.ids()
          expect(ids).toContain("echo")

          const tools = await ToolRegistry.tools({ providerID: "test", modelID: "test" })
          const echo = tools.find((x) => x.id === "echo")
          expect(echo).toBeDefined()
          expect(echo?.description).toBe("Echo test WASM tool")
          const params = echo?.parameters as any
          expect(params.type).toBe("object")
          expect(params.safeParse({ text: "hello" }).success).toBe(true)
          expect(params.safeParse({}).success).toBe(false)

          const result = await echo!.execute({ text: "hello" }, ctx)
          expect(result.output).toBe("ok-from-wasm")
          expect(call).toHaveBeenCalledTimes(1)
          expect(call).toHaveBeenCalledWith(
            expect.objectContaining({
              network: false,
              timeout_ms: 1234,
              memory_pages: 32,
              allowed_hosts: ["example.com"],
              allowed_paths: ["."],
              wasm_path: expect.stringContaining(path.join(".opencode", "tools", "echo.wasm")),
            }),
            "execute",
            JSON.stringify({ text: "hello" }),
          )
        },
      })
    } finally {
      call.mockRestore()
    }
  })

  test("uses metadata function as entrypoint override", async () => {
    const call = spyOn(WasmSandbox, "call").mockResolvedValue("ok-run")
    try {
      await using tmp = await tmpdir({
        config: {
          sandbox: {
            wasm: {
              enabled: true,
              timeout_ms: 1000,
              memory_pages: 32,
              network: false,
            },
          },
        },
        init: async (dir) => {
          const tools = path.join(dir, ".opencode", "tools")
          await fs.mkdir(tools, { recursive: true })
          await Bun.write(path.join(tools, "runner.wasm"), Bun.file(WASM_FIXTURE))
          await Bun.write(
            path.join(tools, "runner.wasm.json"),
            JSON.stringify({
              description: "runner",
              function: "run",
              args: {
                type: "object",
                properties: {},
                additionalProperties: false,
              },
            }),
          )
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tools = await ToolRegistry.tools({ providerID: "test", modelID: "test" })
          const runner = tools.find((x) => x.id === "runner")
          expect(runner).toBeDefined()
          await runner!.execute({}, ctx)
          expect(call).toHaveBeenCalledWith(expect.anything(), "run", JSON.stringify({}))
        },
      })
    } finally {
      call.mockRestore()
    }
  })

  test("uses fallback defaults for missing wasm metadata", async () => {
    await using tmp = await tmpdir({
      config: {
        sandbox: {
          wasm: {
            enabled: true,
            timeout_ms: 1000,
            memory_pages: 32,
            network: false,
          },
        },
      },
      init: async (dir) => {
        const tools = path.join(dir, ".opencode", "tool")
        await fs.mkdir(tools, { recursive: true })
        await Bun.write(path.join(tools, "fallback.wasm"), Bun.file(WASM_FIXTURE))
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tools = await ToolRegistry.tools({ providerID: "test", modelID: "test" })
        const fallback = tools.find((x) => x.id === "fallback")
        expect(fallback).toBeDefined()
        expect(fallback?.description).toBe("Execute the fallback WASM tool.")
        const params = fallback?.parameters as any
        expect(params.type).toBe("object")
        expect(params.safeParse({ input: "hello" }).success).toBe(true)
        expect(params.safeParse({}).success).toBe(false)
      },
    })
  })

  test("coexists with ts tools in same tools directory", async () => {
    await using tmp = await tmpdir({
      config: {
        sandbox: {
          wasm: {
            enabled: true,
            timeout_ms: 1000,
            memory_pages: 32,
            network: false,
          },
        },
      },
      init: async (dir) => {
        const tools = path.join(dir, ".opencode", "tools")
        await fs.mkdir(tools, { recursive: true })
        await Bun.write(path.join(tools, "echo.wasm"), Bun.file(WASM_FIXTURE))
        await Bun.write(path.join(tools, "echo.wasm.json"), Bun.file(WASM_META_FIXTURE))
        await Bun.write(
          path.join(tools, "plain.ts"),
          [
            "export default {",
            "  description: 'plain ts tool',",
            "  args: {},",
            "  execute: async () => 'plain-ok',",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("echo")
        expect(ids).toContain("plain")
      },
    })
  })
})
