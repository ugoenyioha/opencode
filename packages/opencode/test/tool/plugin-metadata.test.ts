import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { ToolRegistry } from "../../src/tool/registry"

describe("plugin metadata", () => {
  test("plugin tool that calls ctx.metadata() preserves custom metadata", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const opencodeDir = path.join(dir, ".opencode")
        await fs.mkdir(opencodeDir, { recursive: true })

        const toolDir = path.join(opencodeDir, "tool")
        await fs.mkdir(toolDir, { recursive: true })

        await Bun.write(
          path.join(toolDir, "meta.ts"),
          [
            "export default {",
            "  description: 'tool that sets metadata',",
            "  args: {},",
            "  execute: async (_args, ctx) => {",
            "    ctx.metadata({ title: 'Custom Title', metadata: { custom_key: 'custom_value', count: 42 } })",
            "    return 'done'",
            "  },",
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
        expect(ids).toContain("meta")

        const tools = await ToolRegistry.tools({ providerID: "test", modelID: "test" })
        const meta = tools.find((t) => t.id === "meta")
        expect(meta).toBeDefined()

        let forwarded: any = null
        const result = await meta!.execute(
          {},
          {
            sessionID: "test",
            messageID: "test",
            agent: "test",
            abort: new AbortController().signal,
            messages: [],
            metadata(input) {
              forwarded = input
            },
            ask: async () => {},
          },
        )

        expect(result.title).toBe("Custom Title")
        expect(result.metadata.custom_key).toBe("custom_value")
        expect(result.metadata.count).toBe(42)
        expect(result.metadata.truncated).toBe(false)
        expect(forwarded).not.toBeNull()
      },
    })
  })

  test("plugin tool without ctx.metadata() still works", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const opencodeDir = path.join(dir, ".opencode")
        await fs.mkdir(opencodeDir, { recursive: true })

        const toolDir = path.join(opencodeDir, "tool")
        await fs.mkdir(toolDir, { recursive: true })

        await Bun.write(
          path.join(toolDir, "plain.ts"),
          [
            "export default {",
            "  description: 'tool without metadata',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'plain result'",
            "  },",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tools = await ToolRegistry.tools({ providerID: "test", modelID: "test" })
        const plain = tools.find((t) => t.id === "plain")
        expect(plain).toBeDefined()

        const result = await plain!.execute(
          {},
          {
            sessionID: "test",
            messageID: "test",
            agent: "test",
            abort: new AbortController().signal,
            messages: [],
            metadata() {},
            ask: async () => {},
          },
        )

        expect(result.title).toBe("")
        expect(result.output).toBe("plain result")
        expect(result.metadata.truncated).toBe(false)
      },
    })
  })

  test("multiple ctx.metadata() calls accumulate metadata", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const opencodeDir = path.join(dir, ".opencode")
        await fs.mkdir(opencodeDir, { recursive: true })

        const toolDir = path.join(opencodeDir, "tool")
        await fs.mkdir(toolDir, { recursive: true })

        await Bun.write(
          path.join(toolDir, "multi.ts"),
          [
            "export default {",
            "  description: 'tool that calls metadata multiple times',",
            "  args: {},",
            "  execute: async (_args, ctx) => {",
            "    ctx.metadata({ title: 'First', metadata: { a: 1 } })",
            "    ctx.metadata({ title: 'Second', metadata: { b: 2 } })",
            "    ctx.metadata({ metadata: { c: 3 } })",
            "    return 'accumulated'",
            "  },",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tools = await ToolRegistry.tools({ providerID: "test", modelID: "test" })
        const multi = tools.find((t) => t.id === "multi")
        expect(multi).toBeDefined()

        const result = await multi!.execute(
          {},
          {
            sessionID: "test",
            messageID: "test",
            agent: "test",
            abort: new AbortController().signal,
            messages: [],
            metadata() {},
            ask: async () => {},
          },
        )

        // Last title wins
        expect(result.title).toBe("Second")
        // All metadata keys accumulated
        expect(result.metadata.a).toBe(1)
        expect(result.metadata.b).toBe(2)
        expect(result.metadata.c).toBe(3)
        expect(result.metadata.truncated).toBe(false)
      },
    })
  })

  test("truncated flag overrides plugin metadata key if conflicting", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const opencodeDir = path.join(dir, ".opencode")
        await fs.mkdir(opencodeDir, { recursive: true })

        const toolDir = path.join(opencodeDir, "tool")
        await fs.mkdir(toolDir, { recursive: true })

        await Bun.write(
          path.join(toolDir, "conflict.ts"),
          [
            "export default {",
            "  description: 'tool that sets truncated in metadata',",
            "  args: {},",
            "  execute: async (_args, ctx) => {",
            "    ctx.metadata({ metadata: { truncated: true, custom: 'yes' } })",
            "    return 'short'",
            "  },",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tools = await ToolRegistry.tools({ providerID: "test", modelID: "test" })
        const conflict = tools.find((t) => t.id === "conflict")
        expect(conflict).toBeDefined()

        const result = await conflict!.execute(
          {},
          {
            sessionID: "test",
            messageID: "test",
            agent: "test",
            abort: new AbortController().signal,
            messages: [],
            metadata() {},
            ask: async () => {},
          },
        )

        // System truncated flag should override plugin's
        expect(result.metadata.truncated).toBe(false)
        expect(result.metadata.custom).toBe("yes")
      },
    })
  })

  test("ctx.metadata() forwards to original metadata handler", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const opencodeDir = path.join(dir, ".opencode")
        await fs.mkdir(opencodeDir, { recursive: true })

        const toolDir = path.join(opencodeDir, "tool")
        await fs.mkdir(toolDir, { recursive: true })

        await Bun.write(
          path.join(toolDir, "forward.ts"),
          [
            "export default {",
            "  description: 'tool that tests forwarding',",
            "  args: {},",
            "  execute: async (_args, ctx) => {",
            "    ctx.metadata({ title: 'Test', metadata: { key: 'val' } })",
            "    return 'forwarded'",
            "  },",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tools = await ToolRegistry.tools({ providerID: "test", modelID: "test" })
        const forward = tools.find((t) => t.id === "forward")
        expect(forward).toBeDefined()

        const calls: any[] = []
        const result = await forward!.execute(
          {},
          {
            sessionID: "test",
            messageID: "test",
            agent: "test",
            abort: new AbortController().signal,
            messages: [],
            metadata(input) {
              calls.push(input)
            },
            ask: async () => {},
          },
        )

        // Original handler was called
        expect(calls.length).toBe(1)
        expect(calls[0].title).toBe("Test")
        expect(calls[0].metadata.key).toBe("val")
        // And result also has the metadata
        expect(result.metadata.key).toBe("val")
      },
    })
  })
})
