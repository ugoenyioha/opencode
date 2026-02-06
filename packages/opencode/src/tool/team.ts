import z from "zod"
import { Tool } from "./tool"
import { Team, TeamTasks, type TeamTask } from "../team"
import { TeamMessaging } from "../team/messaging"
import { Session } from "../session"
import { SessionPrompt } from "../session/prompt"
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { Identifier } from "../id/id"
import { Log } from "../util/log"
import { Bus } from "../bus"
import { TeamEvent } from "../team/events"

const log = Log.create({ service: "tool.team" })

/** Write tools that are denied during plan-approval mode */
const WRITE_TOOLS = ["bash", "write", "edit", "apply_patch"] as const

/**
 * Create a new agent team. Only the lead session should call this.
 */
export const TeamCreateTool = Tool.define("team_create", {
  description:
    "Create a new agent team for coordinating parallel work across multiple sessions. " +
    "You become the team lead. After creating a team, use team_spawn to add teammates, " +
    "and team_tasks to create a shared task list.",
  parameters: z.object({
    name: z
      .string()
      .describe("Team name — lowercase, hyphens allowed. E.g. 'auth-review', 'feature-impl'"),
    tasks: z
      .array(
        z.object({
          id: z.string(),
          content: z.string(),
          priority: z.enum(["high", "medium", "low"]),
          depends_on: z.array(z.string()).optional(),
        }),
      )
      .optional()
      .describe("Optional initial task list for the team"),
    delegate: z
      .boolean()
      .optional()
      .describe(
        "If true, enables delegate mode: the lead is restricted to coordination-only tools " +
        "(team_*, read, glob, grep, list). The lead cannot write, edit, or run bash commands. " +
        "Use this when you want the lead to focus entirely on orchestration.",
      ),
  }),
  async execute(params, ctx): Promise<{ title: string; output: string; metadata: Record<string, any> }> {
    // Constraint: no nested teams — teammates cannot create teams
    const existingTeam = await Team.findBySession(ctx.sessionID)
    if (existingTeam && existingTeam.role === "member") {
      return {
        title: "Error",
        output: "Teammates cannot create new teams. Only the lead session or an independent session can create a team.",
        metadata: {},
      }
    }
    if (existingTeam && existingTeam.role === "lead") {
      return {
        title: "Error",
        output: `You are already leading team "${existingTeam.team.name}". Only one team per session is allowed.`,
        metadata: {},
      }
    }

    const team = await Team.create({
      name: params.name,
      leadSessionID: ctx.sessionID,
      delegate: params.delegate,
    })

    if (params.tasks?.length) {
      const tasks: TeamTask[] = params.tasks.map((t) => ({
        ...t,
        status: "pending" as const,
      }))
      await TeamTasks.add(params.name, tasks)
    }

    // Delegate mode: restrict the lead to coordination-only tools
    if (params.delegate) {
      await Session.update(ctx.sessionID, (draft) => {
        const delegateDenyRules = WRITE_TOOLS.map((tool) => ({
          permission: tool,
          pattern: "*",
          action: "deny" as const,
        }))
        draft.permission = [...(draft.permission ?? []), ...delegateDenyRules]
      })
    }

    return {
      title: `Created team: ${params.name}`,
      output: [
        `Team "${params.name}" created. You are the lead.`,
        params.delegate ? "DELEGATE MODE: You are restricted to coordination tools only (no write/edit/bash)." : "",
        "",
        "Next steps:",
        "- Use team_spawn to add teammates",
        "- Use team_tasks to manage the shared task list",
        "- Use team_message to communicate with teammates",
        params.tasks?.length ? `\nInitial tasks: ${params.tasks.length}` : "",
      ].filter(Boolean).join("\n"),
      metadata: { teamName: params.name, delegate: !!params.delegate },
    }
  },
})

/**
 * Spawn a new teammate — creates a child session and starts its prompt loop.
 */
export const TeamSpawnTool = Tool.define("team_spawn", {
  description:
    "Spawn a new teammate for the current team. Each teammate runs in its own session " +
    "with its own context window. Specify the agent type, a name, and a prompt describing " +
    "what this teammate should work on. You can optionally assign a different model to each " +
    "teammate (e.g. use Gemini for research and Claude for implementation).",
  parameters: z.object({
    name: z.string().describe("Unique name for this teammate, e.g. 'security-reviewer', 'frontend-impl'"),
    agent: z
      .string()
      .optional()
      .describe("Agent type to use (e.g. 'explore', 'general'). Defaults to 'general'."),
    model: z
      .string()
      .optional()
      .describe(
        "Model to use for this teammate in 'provider/model' format, e.g. 'anthropic/claude-sonnet-4-20250514', " +
        "'google/gemini-2.5-pro', 'openai/gpt-4.1'. Must be a model available in your configured providers " +
        "(the same models shown by /models). If omitted, inherits the agent's default or the lead's current model.",
      ),
    prompt: z.string().describe("Initial instructions for the teammate — what they should work on"),
    claim_task: z.string().optional().describe("Task ID to auto-claim for this teammate"),
    require_plan_approval: z
      .boolean()
      .optional()
      .describe(
        "If true, the teammate starts in read-only plan mode. " +
        "They can read/search but cannot write/edit/bash until the lead approves their plan. " +
        "The teammate should research, then send their plan to the lead via team_message. " +
        "The lead can then use team_approve_plan to grant write access.",
      ),
  }),
  async execute(params, ctx): Promise<{ title: string; output: string; metadata: Record<string, any> }> {
    // Constraint: only the lead can spawn — teammates cannot spawn (no nesting)
    const teamInfo = await Team.findBySession(ctx.sessionID)
    if (!teamInfo) {
      return {
        title: "Error",
        output: "You are not the lead of any team. Create a team first with team_create.",
        metadata: {},
      }
    }
    if (teamInfo.role === "member") {
      return {
        title: "Error",
        output: "Teammates cannot spawn other teammates. Only the team lead can spawn new members.",
        metadata: {},
      }
    }
    const teamName = teamInfo.team.name

    // Resolve agent
    const agentName = params.agent ?? "general"
    const agent = await Agent.get(agentName)
    if (!agent) {
      return {
        title: "Error",
        output: `Agent "${agentName}" not found. Available agents: ${(await Agent.list()).map((a) => a.name).join(", ")}`,
        metadata: {},
      }
    }

    // Resolve the model for this teammate early — fail fast before creating session.
    // Priority: explicit params.model > agent.model > lead's current model > default
    const model = await (async () => {
      // 1. Explicit model param — parse and validate against configured providers
      if (params.model) {
        const parsed = Provider.parseModel(params.model)
        try {
          await Provider.getModel(parsed.providerID, parsed.modelID)
        } catch (e: any) {
          if (Provider.ModelNotFoundError.isInstance(e)) {
            const suggestions = e.data.suggestions?.length
              ? ` Did you mean: ${e.data.suggestions.join(", ")}?`
              : ""
            return { error: `Model not found: ${params.model}.${suggestions}` } as const
          }
          throw e
        }
        return parsed
      }
      // 2. Agent's configured model
      if (agent.model) return agent.model
      // 3. Lead's current model (from the last user message in the lead's session)
      const lastUser = ctx.messages.findLast((m) => m.info.role === "user")
      if (lastUser) {
        const info = lastUser.info as { model: { providerID: string; modelID: string } }
        return info.model
      }
      // 4. Global default model
      return await Provider.defaultModel()
    })()

    // Bail out if model resolution failed
    if ("error" in model) {
      return {
        title: "Error",
        output: model.error,
        metadata: {},
      }
    }

    const modelLabel = `${model.providerID}/${model.modelID}`

    // Build permission rules for the child session
    const permissionRules: Array<{ permission: string; pattern: string; action: "deny" | "allow" }> = [
      // Deny lead-only tools — teammates cannot create teams, spawn, shutdown, or cleanup
      { permission: "team_create", pattern: "*", action: "deny" },
      { permission: "team_spawn", pattern: "*", action: "deny" },
      { permission: "team_shutdown", pattern: "*", action: "deny" },
      { permission: "team_cleanup", pattern: "*", action: "deny" },
      { permission: "team_approve_plan", pattern: "*", action: "deny" },
      // Deny todowrite/todoread like normal subagents
      { permission: "todowrite", pattern: "*", action: "deny" },
      { permission: "todoread", pattern: "*", action: "deny" },
    ]

    // Plan approval: deny write tools until the lead approves
    if (params.require_plan_approval) {
      for (const tool of WRITE_TOOLS) {
        permissionRules.push({ permission: tool, pattern: "*", action: "deny" })
      }
    }

    // Create a child session for the teammate
    const session = await Session.create({
      parentID: ctx.sessionID,
      title: `${params.name} (@${agentName} teammate, ${modelLabel})${params.require_plan_approval ? " [plan mode]" : ""}`,
      permission: permissionRules,
    })

    // Register as team member
    await Team.addMember(teamName, {
      name: params.name,
      sessionID: session.id,
      agent: agentName,
      status: "active",
      prompt: params.prompt,
      model: modelLabel,
      planApproval: params.require_plan_approval ? "pending" : "none",
    })

    // Auto-claim a task if requested
    if (params.claim_task) {
      await TeamTasks.claim(teamName, params.claim_task, params.name).catch(() => {})
    }

    // Build the teammate's system context
    const planModeInstructions = params.require_plan_approval
      ? [
          "",
          "IMPORTANT: You are in PLAN MODE (read-only). You can read files, search, and explore,",
          "but you CANNOT write, edit, or run bash commands until the lead approves your plan.",
          "",
          "Your workflow:",
          "1. Research and explore the codebase to understand the problem",
          "2. Formulate a detailed implementation plan",
          "3. Send your plan to the lead using team_message (to: 'lead')",
          "4. Wait for the lead to approve your plan (you'll receive a message when approved)",
          "5. Once approved, your write permissions will be unlocked and you can implement",
          "",
        ]
      : []

    const teamContext = [
      `You are "${params.name}", a teammate in team "${teamName}".`,
      `Your agent type is "${agentName}", using model ${modelLabel}.`,
      "",
      "Team tools available to you:",
      "- team_message: send a message to the lead or another teammate",
      "- team_broadcast: send a message to all teammates",
      "- team_tasks: view/add/complete tasks on the shared task list",
      "- team_claim: claim a pending task from the shared task list",
      "",
      "You do NOT have access to team_create, team_spawn, team_shutdown, or team_cleanup.",
      "Only the team lead can manage the team structure.",
      ...planModeInstructions,
      "When you finish a task, use team_tasks with action 'complete' to mark it done.",
      "Send findings, questions, or status updates to the lead with team_message.",
      "",
      "Your instructions:",
      params.prompt,
    ].join("\n")

    const msgId = Identifier.ascending("message")
    await Session.updateMessage({
      id: msgId,
      sessionID: session.id,
      role: "user",
      agent: agentName,
      model,
      time: { created: Date.now() },
    })
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: msgId,
      sessionID: session.id,
      type: "text",
      text: teamContext,
    })

    // Start the teammate's prompt loop in the background
    log.info("spawning teammate", { teamName, name: params.name, sessionID: session.id })
    const notifyLead = async (status: "finished" | "errored", error?: string) => {
      try {
        await Team.setMemberStatus(teamName, params.name, "idle")
        // Notify the lead session that this teammate is done
        await TeamMessaging.send({
          teamName,
          from: params.name,
          to: "lead",
          text: status === "finished"
            ? `I have finished my work and am now idle. Review my session (${session.id}) for results.`
            : `I encountered an error and stopped: ${error ?? "unknown error"}. Review my session (${session.id}).`,
        })
      } catch (notifyErr: any) {
        log.warn("failed to notify lead of teammate completion", {
          teamName,
          name: params.name,
          error: notifyErr.message,
        })
      }
    }

    SessionPrompt.loop(session.id)
      .then(() => {
        log.info("teammate loop finished", { teamName, name: params.name })
        notifyLead("finished")
      })
      .catch((err) => {
        log.warn("teammate loop error", { teamName, name: params.name, error: err.message })
        notifyLead("errored", err.message)
      })

    return {
      title: `Spawned teammate: ${params.name}`,
      output: [
        `Teammate "${params.name}" spawned with agent "${agentName}" using model ${modelLabel}.`,
        `Session ID: ${session.id}`,
        params.claim_task ? `Auto-claimed task: ${params.claim_task}` : "",
        params.require_plan_approval
          ? "Plan approval REQUIRED: teammate is in read-only mode until you approve their plan with team_approve_plan."
          : "",
        "",
        "The teammate is now working independently. Use team_message to communicate.",
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: { teamName, memberName: params.name, sessionID: session.id, model: modelLabel, planApproval: params.require_plan_approval },
    }
  },
})

/**
 * Send a message to a specific teammate or the lead.
 */
export const TeamMessageTool = Tool.define("team_message", {
  description:
    "Send a message to a specific teammate or the team lead. " +
    "Use this to share findings, ask questions, or coordinate work.",
  parameters: z.object({
    to: z.string().describe("Name of the recipient teammate, or 'lead' to message the team lead"),
    text: z.string().describe("The message content"),
  }),
  async execute(params, ctx): Promise<{ title: string; output: string; metadata: Record<string, any> }> {
    const teamInfo = await Team.findBySession(ctx.sessionID)
    if (!teamInfo) {
      return {
        title: "Error",
        output: "You are not part of any team.",
        metadata: {},
      }
    }

    const fromName = teamInfo.role === "lead" ? "lead" : teamInfo.memberName!

    await TeamMessaging.send({
      teamName: teamInfo.team.name,
      from: fromName,
      to: params.to,
      text: params.text,
    })

    return {
      title: `Message sent to ${params.to}`,
      output: `Message delivered to "${params.to}".`,
      metadata: { to: params.to },
    }
  },
})

/**
 * Broadcast a message to all teammates.
 */
export const TeamBroadcastTool = Tool.define("team_broadcast", {
  description:
    "Send a message to all teammates simultaneously. Use sparingly — " +
    "prefer targeted messages. Good for announcements or shared context updates.",
  parameters: z.object({
    text: z.string().describe("The message to broadcast to all teammates"),
  }),
  async execute(params, ctx): Promise<{ title: string; output: string; metadata: Record<string, any> }> {
    const teamInfo = await Team.findBySession(ctx.sessionID)
    if (!teamInfo) {
      return {
        title: "Error",
        output: "You are not part of any team.",
        metadata: {},
      }
    }

    const fromName = teamInfo.role === "lead" ? "lead" : teamInfo.memberName!

    await TeamMessaging.broadcast({
      teamName: teamInfo.team.name,
      from: fromName,
      text: params.text,
    })

    return {
      title: "Broadcast sent",
      output: `Broadcast sent to all teammates in "${teamInfo.team.name}".`,
      metadata: {},
    }
  },
})

/**
 * View or update the shared task list.
 */
export const TeamTasksTool = Tool.define("team_tasks", {
  description:
    "View or update the shared task list for the team. " +
    "Use action 'list' to see all tasks, 'add' to add new tasks, " +
    "'complete' to mark a task done, or 'update' to replace the full list.",
  parameters: z.object({
    action: z.enum(["list", "add", "complete", "update"]).describe("What to do with the task list"),
    tasks: z
      .array(
        z.object({
          id: z.string(),
          content: z.string(),
          status: z.enum(["pending", "in_progress", "completed", "cancelled", "blocked"]),
          priority: z.enum(["high", "medium", "low"]),
          assignee: z.string().optional(),
          depends_on: z.array(z.string()).optional(),
        }),
      )
      .optional()
      .describe("Tasks to add or the full replacement list (for 'add' and 'update' actions)"),
    task_id: z.string().optional().describe("Task ID to complete (for 'complete' action)"),
  }),
  async execute(params, ctx): Promise<{ title: string; output: string; metadata: Record<string, any> }> {
    const teamInfo = await Team.findBySession(ctx.sessionID)
    if (!teamInfo) {
      return { title: "Error", output: "You are not part of any team.", metadata: {} }
    }
    const teamName = teamInfo.team.name

    switch (params.action) {
      case "list": {
        const tasks = await TeamTasks.list(teamName)
        if (tasks.length === 0) {
          return { title: "Task list", output: "No tasks in the team task list.", metadata: {} }
        }
        const output = tasks
          .map((t) => {
            const status = t.status === "in_progress" ? `in_progress (${t.assignee ?? "?"})` : t.status
            const deps = t.depends_on?.length ? ` [deps: ${t.depends_on.join(", ")}]` : ""
            return `[${t.id}] ${t.content} — ${status} (${t.priority})${deps}`
          })
          .join("\n")
        return { title: "Task list", output, metadata: { count: tasks.length } }
      }
      case "add": {
        if (!params.tasks?.length) {
          return { title: "Error", output: "No tasks provided to add.", metadata: {} }
        }
        await TeamTasks.add(teamName, params.tasks as TeamTask[])
        return {
          title: `Added ${params.tasks.length} tasks`,
          output: `Added ${params.tasks.length} task(s) to the shared list.`,
          metadata: {},
        }
      }
      case "complete": {
        if (!params.task_id) {
          return { title: "Error", output: "No task_id provided.", metadata: {} }
        }
        await TeamTasks.complete(teamName, params.task_id)
        return {
          title: `Completed task ${params.task_id}`,
          output: `Task "${params.task_id}" marked as completed. Dependent tasks may have been unblocked.`,
          metadata: {},
        }
      }
      case "update": {
        if (!params.tasks) {
          return { title: "Error", output: "No tasks provided for update.", metadata: {} }
        }
        await TeamTasks.update(teamName, params.tasks as TeamTask[])
        return {
          title: "Task list updated",
          output: `Replaced task list with ${params.tasks.length} task(s).`,
          metadata: {},
        }
      }
    }
  },
})

/**
 * Claim a pending task from the shared task list.
 */
export const TeamClaimTool = Tool.define("team_claim", {
  description:
    "Claim a pending task from the team's shared task list. " +
    "Only pending, unassigned tasks with resolved dependencies can be claimed. " +
    "Uses file locking to prevent race conditions.",
  parameters: z.object({
    task_id: z.string().describe("The ID of the task to claim"),
  }),
  async execute(params, ctx): Promise<{ title: string; output: string; metadata: Record<string, any> }> {
    const teamInfo = await Team.findBySession(ctx.sessionID)
    if (!teamInfo) {
      return { title: "Error", output: "You are not part of any team.", metadata: {} }
    }

    const memberName = teamInfo.role === "lead" ? "lead" : teamInfo.memberName!
    const claimed = await TeamTasks.claim(teamInfo.team.name, params.task_id, memberName)

    if (claimed) {
      return {
        title: `Claimed task ${params.task_id}`,
        output: `You claimed task "${params.task_id}". It's now in_progress assigned to you.`,
        metadata: { taskId: params.task_id },
      }
    } else {
      return {
        title: "Claim failed",
        output: `Could not claim task "${params.task_id}". It may already be taken, blocked, or not found.`,
        metadata: {},
      }
    }
  },
})

/**
 * Approve or reject a teammate's plan — lifts write restrictions on approval.
 */
export const TeamApprovePlanTool = Tool.define("team_approve_plan", {
  description:
    "Approve or reject a teammate's implementation plan. When a teammate is spawned with " +
    "require_plan_approval=true, they start in read-only mode and must submit a plan. " +
    "Use this tool to approve (unlocks write tools) or reject (teammate revises their plan).",
  parameters: z.object({
    name: z.string().describe("Name of the teammate whose plan to review"),
    approved: z.boolean().describe("true to approve the plan and unlock write access, false to reject"),
    feedback: z.string().optional().describe("Feedback for the teammate — required on rejection, optional on approval"),
  }),
  async execute(params, ctx): Promise<{ title: string; output: string; metadata: Record<string, any> }> {
    const teamInfo = await Team.findBySession(ctx.sessionID)
    if (!teamInfo || teamInfo.role !== "lead") {
      return { title: "Error", output: "Only the team lead can approve plans.", metadata: {} }
    }

    const member = teamInfo.team.members.find((m) => m.name === params.name)
    if (!member) {
      return { title: "Error", output: `Teammate "${params.name}" not found.`, metadata: {} }
    }
    if (member.planApproval !== "pending") {
      return {
        title: "Error",
        output: `Teammate "${params.name}" is not awaiting plan approval (current: ${member.planApproval ?? "none"}).`,
        metadata: {},
      }
    }

    if (params.approved) {
      // Update the session's permissions to remove write tool denials
      await Session.update(member.sessionID, (draft) => {
        if (draft.permission) {
          draft.permission = draft.permission.filter(
            (rule) => !WRITE_TOOLS.includes(rule.permission as any),
          )
        }
      })

      // Update member state
      await Team.setMemberPlanApproval(teamInfo.team.name, params.name, "approved")

      // Notify the teammate
      await TeamMessaging.send({
        teamName: teamInfo.team.name,
        from: "lead",
        to: params.name,
        text: params.feedback
          ? `Your plan has been APPROVED. You now have full write access. Feedback: ${params.feedback}`
          : "Your plan has been APPROVED. You now have full write access. Proceed with implementation.",
      })

      await Bus.publish(TeamEvent.PlanApproval, {
        teamName: teamInfo.team.name,
        memberName: params.name,
        approved: true,
        feedback: params.feedback,
      })

      return {
        title: `Plan approved: ${params.name}`,
        output: `Approved "${params.name}"'s plan. Write tools are now unlocked for this teammate.`,
        metadata: { approved: true },
      }
    } else {
      // Rejected — keep read-only mode, update state
      await Team.setMemberPlanApproval(teamInfo.team.name, params.name, "rejected")

      // After rejection, reset to pending so they can resubmit
      // (we keep planApproval as "pending" so the flow continues)
      await Team.setMemberPlanApproval(teamInfo.team.name, params.name, "pending")

      await TeamMessaging.send({
        teamName: teamInfo.team.name,
        from: "lead",
        to: params.name,
        text: `Your plan has been REJECTED. Please revise and resubmit. Feedback: ${params.feedback ?? "No specific feedback provided."}`,
      })

      await Bus.publish(TeamEvent.PlanApproval, {
        teamName: teamInfo.team.name,
        memberName: params.name,
        approved: false,
        feedback: params.feedback,
      })

      return {
        title: `Plan rejected: ${params.name}`,
        output: `Rejected "${params.name}"'s plan. They remain in read-only mode and should revise.`,
        metadata: { approved: false },
      }
    }
  },
})

/**
 * Request a teammate to shut down. The teammate can approve or reject.
 */
export const TeamShutdownTool = Tool.define("team_shutdown", {
  description:
    "Request a teammate to shut down gracefully. The teammate receives the shutdown request " +
    "and can either approve (wraps up and exits) or reject (continues working with an explanation). " +
    "Only the team lead should use this.",
  parameters: z.object({
    name: z.string().describe("Name of the teammate to shut down"),
    reason: z.string().optional().describe("Reason for the shutdown request"),
  }),
  async execute(params, ctx): Promise<{ title: string; output: string; metadata: Record<string, any> }> {
    const teamInfo = await Team.findBySession(ctx.sessionID)
    if (!teamInfo || teamInfo.role !== "lead") {
      return { title: "Error", output: "Only the team lead can shut down teammates.", metadata: {} }
    }

    const member = teamInfo.team.members.find((m) => m.name === params.name)
    if (!member) {
      return {
        title: "Error",
        output: `Teammate "${params.name}" not found.`,
        metadata: {},
      }
    }
    if (member.status === "shutdown") {
      return {
        title: "Already shutdown",
        output: `Teammate "${params.name}" is already shut down.`,
        metadata: {},
      }
    }

    const reason = params.reason ?? "The lead has requested you shut down."

    // Send a shutdown request message — the teammate can approve or reject
    await TeamMessaging.send({
      teamName: teamInfo.team.name,
      from: "lead",
      to: params.name,
      text: [
        `SHUTDOWN REQUEST: ${reason}`,
        "",
        "Please do one of the following:",
        "1. If you can wrap up, summarize your findings and send them to the lead, then stop working.",
        "2. If you need more time, reply to the lead explaining why you should continue.",
      ].join("\n"),
    })

    await Bus.publish(TeamEvent.ShutdownRequest, {
      teamName: teamInfo.team.name,
      memberName: params.name,
    })

    // Mark as shutdown — the teammate's loop will finish naturally after processing
    await Team.setMemberStatus(teamInfo.team.name, params.name, "shutdown")

    return {
      title: `Shutdown requested: ${params.name}`,
      output: `Shutdown request sent to "${params.name}". They will finish their current work and stop. If they reject, they will message you with an explanation.`,
      metadata: {},
    }
  },
})

/**
 * Clean up the team — remove config and task files.
 */
export const TeamCleanupTool = Tool.define("team_cleanup", {
  description:
    "Clean up the team by removing all team resources (config, task list). " +
    "All teammates must be shut down first. Only the lead should call this.",
  parameters: z.object({
    name: z.string().describe("Team name to clean up"),
  }),
  async execute(params, ctx): Promise<{ title: string; output: string; metadata: Record<string, any> }> {
    try {
      await Team.cleanup(params.name)
      return {
        title: `Team cleaned up: ${params.name}`,
        output: `Team "${params.name}" has been cleaned up. All resources removed.`,
        metadata: {},
      }
    } catch (err: any) {
      return {
        title: "Cleanup failed",
        output: `Failed to clean up team: ${err.message}`,
        metadata: {},
      }
    }
  },
})
