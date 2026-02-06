import { describe, expect, test } from "bun:test"
import path from "path"
import { MemorySaveTool } from "../../src/tool/memory-save"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

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

describe("tool.memory_save", () => {
  test("creates memory file and writes fact", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await MemorySaveTool.init()
        const result = await tool.execute({ fact: "Always use tabs for indentation" }, ctx)

        expect(result.title).toBe("Saved to memory")
        expect(result.output).toContain("Always use tabs for indentation")

        const memoryFile = path.join(tmp.path, ".opencode", "rules", "memory.md")
        const content = await Bun.file(memoryFile).text()
        expect(content).toContain("Always use tabs for indentation")
      },
    })
  })

  test("appends to existing memory file", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, ".opencode", "rules", "memory.md"),
          "- Existing fact (2025-01-01)\n",
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await MemorySaveTool.init()
        await tool.execute({ fact: "New fact to remember" }, ctx)

        const memoryFile = path.join(tmp.path, ".opencode", "rules", "memory.md")
        const content = await Bun.file(memoryFile).text()
        expect(content).toContain("Existing fact")
        expect(content).toContain("New fact to remember")

        // Should be two lines
        const lines = content.trim().split("\n").filter((l) => l.startsWith("- "))
        expect(lines.length).toBe(2)
      },
    })
  })

  test("includes date in entry", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await MemorySaveTool.init()
        await tool.execute({ fact: "Test date inclusion" }, ctx)

        const memoryFile = path.join(tmp.path, ".opencode", "rules", "memory.md")
        const content = await Bun.file(memoryFile).text()
        // Should contain today's date in YYYY-MM-DD format
        const today = new Date().toISOString().split("T")[0]
        expect(content).toContain(today)
      },
    })
  })

  test("creates .opencode/rules/ directory if it doesn't exist", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const rulesDir = path.join(tmp.path, ".opencode", "rules")
        const existsBefore = await Bun.file(path.join(rulesDir, "memory.md")).exists()
        expect(existsBefore).toBe(false)

        const tool = await MemorySaveTool.init()
        await tool.execute({ fact: "Creates directory" }, ctx)

        const existsAfter = await Bun.file(path.join(rulesDir, "memory.md")).exists()
        expect(existsAfter).toBe(true)
      },
    })
  })

  test("saved facts are picked up by instruction system", async () => {
    const { InstructionPrompt } = await import("../../src/session/instruction")

    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await MemorySaveTool.init()
        await tool.execute({ fact: "Use PostgreSQL not MySQL" }, ctx)

        // The rules loading system should pick this up as an unconditional rule
        const instructions = await InstructionPrompt.system()
        const memoryRule = instructions.find((s) => s.includes("memory.md"))
        expect(memoryRule).toBeDefined()
        expect(memoryRule).toContain("Use PostgreSQL not MySQL")
      },
    })
  })
})
