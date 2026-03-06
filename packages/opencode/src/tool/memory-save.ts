import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { InstructionPrompt } from "../session/instruction"
import { sanitizeForStorage } from "../util/input-sanitization"
import DESCRIPTION from "./memory-save.txt"

export const MemorySaveTool = Tool.define("memory_save", {
  description: DESCRIPTION,
  parameters: z.object({
    fact: z
      .string()
      .describe("The specific fact or piece of information to remember. Should be a clear, self-contained statement."),
  }),
  async execute(params, ctx) {
    // G4 Security Fix: Validate content before saving to prevent cross-session infection
    // Rejects: invisible Unicode, code fences, HTML tags, YAML frontmatter
    // See: /tmp/audit-input-v2.md Pattern 2.3, /tmp/master-remediation-plan.md Phase 5
    const validation = sanitizeForStorage(params.fact)
    if (!validation.valid) {
      throw new Error(`Cannot save fact: ${validation.reason}`)
    }

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

    // Use the sanitized content (newlines already collapsed, content validated)
    const timestamp = new Date().toISOString().split("T")[0]
    const entry = `- ${validation.sanitized} (${timestamp})`
    const newContent = existing ? existing.trimEnd() + "\n" + entry + "\n" : entry + "\n"

    await Bun.write(memoryFile, newContent)

    // Invalidate cached rules so the new memory entry is picked up immediately
    // This is safe now because we've validated the content above
    InstructionPrompt.invalidateRules()

    return {
      title: "Saved to memory",
      output: `Saved to ${memoryFile}: ${validation.sanitized}`,
      metadata: {
        file: memoryFile,
        fact: validation.sanitized,
      },
    }
  },
})
