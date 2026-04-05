import { Tool } from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { Session } from "../session"
import { MessageV2 } from "../session/message-v2"
import { Identifier } from "../id/id"
import { Agent } from "../agent/agent"
import { SessionPrompt } from "../session/prompt"
import { iife } from "@/util/iife"
import { defer } from "@/util/defer"
import { Config } from "../config/config"
import { PermissionNext } from "@/permission/next"
import { Worktree } from "../worktree"
import { SessionID, MessageID } from "../session/schema"
import { Flag } from "@/flag/flag"

/**
 * Calculate the subagent nesting depth for a session by walking up the parentID chain.
 * Returns 0 for a root session, 1 for a direct child, etc.
 */
async function getSubagentDepth(sessionID: string): Promise<number> {
  let depth = 0
  let current = sessionID
  while (true) {
    const session = await Session.get(current).catch(() => undefined)
    if (!session || !session.parentID) break
    depth++
    current = session.parentID
  }
  return depth
}

/** All team tools that must be denied for task subagents to prevent
 *  accidental bridge into the team communication graph. */
const TEAM_TOOLS = [
  "team_create",
  "team_spawn",
  "team_message",
  "team_broadcast",
  "team_tasks",
  "team_claim",
  "team_approve_plan",
  "team_shutdown",
  "team_cleanup",
  "team_status",
] as const

const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z
    .string()
    .describe(
      "The type of specialized agent to use for this task. " +
        "Omit to fork the current session (inherits full message history for cache sharing).",
    )
    .optional(),
  task_id: z
    .string()
    .describe(
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
    )
    .optional(),
  command: z.string().describe("The command that triggered this task").optional(),
})

export const TaskTool = Tool.define("task", async (ctx) => {
  const agents = await Agent.list().then((x) => x.filter((a) => a.mode !== "primary"))

  // Filter agents by permissions if agent provided
  const caller = ctx?.agent
  const accessibleAgents = caller
    ? agents.filter((a) => PermissionNext.evaluate("task", a.name, caller.permission).action !== "deny")
    : agents

  const description = DESCRIPTION.replace(
    "{agents}",
    accessibleAgents
      .map((a) => `- ${a.name}: ${a.description ?? "This subagent should only be called manually by the user."}`)
      .join("\n"),
  )
  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      const config = await Config.get()

      // Guard: enforce max subagent depth limit
      const maxSubagentDepth = config.server?.limits?.max_subagent_depth ?? 5
      const currentDepth = await getSubagentDepth(ctx.sessionID)
      if (currentDepth >= maxSubagentDepth) {
        throw new Error(
          `Maximum subagent nesting depth of ${maxSubagentDepth} exceeded (current depth: ${currentDepth}). ` +
            `Cannot spawn nested subagent. Consider restructuring the task to avoid deep nesting.`,
        )
      }

      // Fork mode: no subagent_type → fork current session (inherits message history)
      if (!params.subagent_type) {
        if (!Flag.OPENCODE_FORK_SUBAGENT)
          throw new Error(
            "Fork mode requires OPENCODE_FORK_SUBAGENT=1. " +
              "Set the env var or provide a subagent_type to use a specific agent.",
          )

        const parentSession = await Session.get(ctx.sessionID)
        // Anti-recursion: forked sessions cannot fork further
        if (parentSession?.title?.includes("(fork #"))
          throw new Error("Forked sessions cannot fork again. Provide a subagent_type instead.")

        const forked = await Session.fork({ sessionID: ctx.sessionID })

        ctx.metadata({
          title: params.description,
          metadata: { sessionId: forked.id, fork: true },
        })

        const messageID = MessageID.ascending()


        // Use the parent's model from the triggering assistant message
        const triggerMsg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
        if (triggerMsg.info.role !== "assistant") throw new Error("Not an assistant message")
        const forkModel = { modelID: triggerMsg.info.modelID, providerID: triggerMsg.info.providerID }

        const promptParts = await SessionPrompt.resolvePromptParts(params.prompt)

        const result = await SessionPrompt.prompt({
          messageID,
          sessionID: forked.id,
          model: forkModel,
          agent: ctx.agent ?? "general",
          parts: promptParts,
        })

        const text = result.parts.findLast((x: MessageV2.Part) => x.type === "text")?.text ?? ""
        return {
          title: params.description,
          metadata: { sessionId: forked.id, fork: true, cancelled: false },
          output: [
            `task_id: ${forked.id} (forked session — resume with this id)`,
            "",
            "<task_result>",
            text,
            "</task_result>",
          ].join("\n"),
        }
      }

      // Skip permission check when user explicitly invoked via @ or command subtask
      if (!ctx.extra?.bypassAgentCheck) {
        await ctx.ask({
          permission: "task",
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const agent = await Agent.get(params.subagent_type)
      if (!agent) throw new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`)

      const hasTaskPermission = agent.permission.some((rule) => rule.permission === "task")

      // Inherit the caller agent's permission rules so subagents respect
      // permissive configs like "allow": "*" (fixes upstream #12566)
      const caller = ctx.agent ? await Agent.get(ctx.agent).catch(() => undefined) : undefined
      const parentSession = await Session.get(ctx.sessionID).catch(() => undefined)

      const session = await iife(async () => {
        if (params.task_id) {
          const found = await Session.get(params.task_id).catch(() => {})
          if (found) return found
        }

        const sessionID = SessionID.descending()
        let directory: string | undefined

        if (agent.isolation === "worktree") {
          try {
            const worktree = await Worktree.create({ name: sessionID })
            directory = worktree.directory
          } catch (err) {
            console.warn("Failed to create isolated worktree, falling back to standard directory", err)
          }
        }

        return await Session.create({
          id: sessionID,
          parentID: ctx.sessionID,
          title: params.description + ` (@${agent.name} subagent)`,
          directory,
          permission: [
            // Inherit caller agent's permission rules (includes user config)
            ...(caller?.permission ?? []),
            // Inherit parent session's accumulated permission rules
            ...(parentSession?.permission ?? []),
            // Subagent-specific overrides (deny todo/session_task/task/team tools)
            {
              permission: "todowrite",
              pattern: "*",
              action: "deny",
            },
            {
              permission: "todoread",
              pattern: "*",
              action: "deny",
            },
            {
              permission: "session_task_create",
              pattern: "*",
              action: "deny",
            },
            {
              permission: "session_task_update",
              pattern: "*",
              action: "deny",
            },
            {
              permission: "session_task_get",
              pattern: "*",
              action: "deny",
            },
            {
              permission: "session_task_list",
              pattern: "*",
              action: "deny",
            },
            ...(hasTaskPermission
              ? []
              : [
                  {
                    permission: "task" as const,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),
            // Deny all team tools — subagents are private utilities,
            // not participants in the team communication graph.
            ...TEAM_TOOLS.map((t) => ({
              permission: t,
              pattern: "*" as const,
              action: "deny" as const,
            })),
            ...(config.experimental?.primary_tools?.map((t) => ({
              pattern: "*",
              action: "allow" as const,
              permission: t,
            })) ?? []),
          ],
        })
      })
      const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
      if (msg.info.role !== "assistant") throw new Error("Not an assistant message")

      const model = agent.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }

      ctx.metadata({
        title: params.description,
        metadata: {
          sessionId: session.id,
          model,
        },
      })

      const messageID = MessageID.ascending()

      function cancel() {
        SessionPrompt.cancel(session.id)
      }
      ctx.abort.addEventListener("abort", cancel)
      using _ = defer(() => ctx.abort.removeEventListener("abort", cancel))
      const promptParts = await SessionPrompt.resolvePromptParts(params.prompt)

      const result = await SessionPrompt.prompt({
        messageID,
        sessionID: session.id,
        model: {
          modelID: model.modelID,
          providerID: model.providerID,
        },
        agent: agent.name,
        tools: {
          todowrite: false,
          todoread: false,
          session_task_create: false,
          session_task_update: false,
          session_task_get: false,
          session_task_list: false,
          ...(hasTaskPermission ? {} : { task: false }),
          // Hide all team tools from subagents — they communicate
          // only with their parent, never directly with the team.
          ...Object.fromEntries(TEAM_TOOLS.map((t) => [t, false])),
          ...Object.fromEntries((config.experimental?.primary_tools ?? []).map((t) => [t, false])),
        },
        parts: promptParts,
      })

      const text = result.parts.findLast((x: MessageV2.Part) => x.type === "text")?.text ?? ""

      const output = [
        `task_id: ${session.id} (for resuming to continue this task if needed)`,
        "",
        "<task_result>",
        text,
        "</task_result>",
      ].join("\n")

      return {
        title: params.description,
        metadata: {
          sessionId: session.id,
          model,
          cancelled: false,
        },
        output,
      }
    },
  }
})
