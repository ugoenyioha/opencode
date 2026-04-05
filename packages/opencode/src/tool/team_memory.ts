import z from "zod"
import { Tool } from "./tool"
import { TeamMemory } from "../team/memory"
import { Flag } from "@/flag/flag"

function flagGuard() {
  if (!Flag.OPENCODE_TEAM_MEMORY)
    throw new Error("team_memory tools require OPENCODE_TEAM_MEMORY=1")
}

/**
 * Write a fact or note to the shared team memory store.
 * All teammates and the lead can read the stored facts on their next turn.
 */
export const TeamMemoryWriteTool = Tool.define("team_memory_write", {
  description:
    "Write a fact, finding, or note to the shared team memory store. " +
    "Team memory persists across sessions and is visible to all teammates. " +
    "Use for: architectural decisions, discovered constraints, shared context " +
    "that all teammates need. Do NOT store secrets or credentials. " +
    "Use a descriptive key (e.g. 'auth-architecture', 'db-schema', 'api-endpoints').",
  parameters: z.object({
    key: z
      .string()
      .describe(
        "Descriptive key for this memory entry (lowercase, hyphens allowed, max 64 chars). " +
          "Acts as a filename — writing to the same key appends/updates that entry.",
      ),
    content: z
      .string()
      .describe("The fact or note to store. Plain text, max 8KB. No secrets or credentials."),
  }),
  async execute(params, ctx) {
    flagGuard()
    await ctx.ask({
      permission: "team_memory_write",
      patterns: ["*"],
      always: ["*"],
      metadata: { key: params.key },
    })
    const filepath = await TeamMemory.write(params.key, params.content)
    return {
      title: `Stored: ${params.key}`,
      output: `Saved to team memory key "${params.key}" at ${filepath}.`,
      metadata: { key: params.key, filepath },
    }
  },
})

/**
 * Read all entries from the shared team memory store.
 */
export const TeamMemoryReadTool = Tool.define("team_memory_read", {
  description:
    "Read all entries from the shared team memory store. " +
    "Returns all facts and notes previously written by any teammate or the lead. " +
    "Call this at the start of a session to catch up on shared context.",
  parameters: z.object({
    key: z
      .string()
      .optional()
      .describe("Optional: read a specific key only. Omit to read all entries."),
  }),
  async execute(params, _ctx) {
    flagGuard()
    const all = await TeamMemory.readAll()
    if (all.size === 0) {
      return {
        title: "Team memory (empty)",
        output: "No team memory entries found for this project.",
        metadata: { count: 0, key: undefined as string | undefined },
      }
    }
    if (params.key) {
      const safe = params.key.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/, "").slice(0, 64)
      const content = all.get(safe)
      if (!content) {
        return {
          title: `Team memory: ${params.key} (not found)`,
          output: `No entry found for key "${params.key}".`,
          metadata: { count: 0, key: safe as string | undefined },
        }
      }
      return {
        title: `Team memory: ${params.key}`,
        output: content.trim(),
        metadata: { count: 1, key: safe as string | undefined },
      }
    }
    const lines: string[] = [`Team memory (${all.size} entries):\n`]
    for (const [key, content] of all) {
      lines.push(`### ${key}\n${content.trim()}\n`)
    }
    return {
      title: `Team memory (${all.size} entries)`,
      output: lines.join("\n"),
      metadata: { count: all.size, key: undefined as string | undefined },
    }
  },
})
