import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { InstructionPrompt } from "../session/instruction"
import DESCRIPTION from "./memory-save.txt"

export const MemorySaveTool = Tool.define("memory_save", {
  description: DESCRIPTION,
  parameters: z.object({
    fact: z
      .string()
      .describe(
        "The specific fact or piece of information to remember. Should be a clear, self-contained statement.",
      ),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "memory_save",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })

    const rulesDir = path.join(Instance.directory, ".opencode", "rules")
    await import("fs/promises").then((fs) => fs.mkdir(rulesDir, { recursive: true }))

    const memoryFile = path.join(rulesDir, "memory.md")
    const existing = await Bun.file(memoryFile)
      .text()
      .catch(() => "")

    // Sanitize: strip newlines to prevent YAML frontmatter injection (--- delimiters)
    // and collapse to a single-line bullet point
    const sanitized = params.fact.replace(/\r?\n/g, " ").replace(/^---/g, "").trim()
    const timestamp = new Date().toISOString().split("T")[0]
    const entry = `- ${sanitized} (${timestamp})`
    const newContent = existing ? existing.trimEnd() + "\n" + entry + "\n" : entry + "\n"

    await Bun.write(memoryFile, newContent)

    // Invalidate cached rules so the new memory entry is picked up immediately
    InstructionPrompt.invalidateRules()

    return {
      title: "Saved to memory",
      output: `Saved to ${memoryFile}: ${params.fact}`,
      metadata: {
        file: memoryFile,
        fact: params.fact,
      },
    }
  },
})
