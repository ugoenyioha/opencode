import z from "zod"
import { Log } from "../util/log"
import { Bus } from "../bus"
import { Instance } from "../project/instance"
import { Storage } from "../storage/storage"
import { fn } from "../util/fn"
import {
  TeamEvent,
  TeamInfoSchema,
  TeamTaskSchema,
  type TeamInfo,
  type TeamMember,
  type TeamTask,
  type MemberStatus,
} from "./events"

export { TeamEvent, TeamInfoSchema, TeamTaskSchema, type TeamInfo, type TeamMember, type TeamTask } from "./events"

/** Write tools that are denied during plan-approval or delegate mode */
export const WRITE_TOOLS = ["bash", "write", "edit", "multiedit", "apply_patch"] as const

const log = Log.create({ service: "team" })

/** Storage key for a team's config */
function configKey(name: string): string[] {
  return ["team", Instance.project.id, name]
}

/** Storage key for a team's task list — separate prefix from "team" so
 *  Storage.list(["team", projectID]) only returns config keys, not task data */
function tasksKey(name: string): string[] {
  return ["team_tasks", Instance.project.id, name]
}

export namespace Team {
  /**
   * Subscribe to member status changes and auto-cleanup teams
   * when all members have reached "shutdown" status.
   * Called once during InstanceBootstrap.
   */
  export function autoCleanup(): () => void {
    return Bus.subscribe(TeamEvent.MemberStatusChanged, async (event) => {
      if (event.properties.status !== "shutdown") return

      const team = await get(event.properties.teamName)
      if (!team) return
      if (team.members.length === 0) return
      if (team.members.some((m) => m.status !== "shutdown")) return

      log.info("all members shutdown, auto-cleaning team", { teamName: team.name })
      try {
        await cleanup(team.name)
      } catch (err: unknown) {
        log.warn("auto-cleanup failed", {
          teamName: team.name,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })
  }

  /**
   * Listen for TeamEvent.Cleaned and restore session permissions.
   * This decouples the team module from the session module —
   * cleanup only publishes the event, this listener handles session side-effects.
   */
  export function onCleanedRestorePermissions(): () => void {
    return Bus.subscribe(TeamEvent.Cleaned, async (event) => {
      if (!event.properties.delegate) return

      try {
        const { Session } = await import("../session")
        await Session.update(event.properties.leadSessionID, (draft) => {
          draft.permission = (draft.permission ?? []).filter(
            (rule) => !((WRITE_TOOLS as readonly string[]).includes(rule.permission) && rule.action === "deny"),
          )
        })
        log.info("restored lead session permissions", {
          teamName: event.properties.teamName,
          sessionID: event.properties.leadSessionID,
        })
      } catch (err: unknown) {
        log.warn("failed to restore lead session permissions", {
          teamName: event.properties.teamName,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })
  }

  /**
   * Create a new team. The lead session is the caller's session.
   */
  export const create = fn(
    z.object({
      name: z.string(),
      leadSessionID: z.string(),
      delegate: z.boolean().optional(),
    }),
    async (input) => {
      const existing = await get(input.name)
      if (existing) throw new Error(`Team "${input.name}" already exists`)

      const lead = await findBySession(input.leadSessionID)
      if (lead?.role === "lead")
        throw new Error(`Session is already leading team "${lead.team.name}". Only one team per session is allowed.`)
      if (lead?.role === "member")
        throw new Error(`This session is a teammate in "${lead.team.name}". Teammates cannot create new teams.`)

      const team: TeamInfo = {
        name: input.name,
        leadSessionID: input.leadSessionID,
        members: [],
        created: Date.now(),
        ...(input.delegate ? { delegate: true } : {}),
      }

      await Storage.write(configKey(input.name), team)
      await Storage.write(tasksKey(input.name), [] as TeamTask[])

      log.info("team created", { name: input.name, leadSessionID: input.leadSessionID })
      await Bus.publish(TeamEvent.Created, { team })
      return team
    },
  )

  /**
   * Get a team by name. Returns undefined if not found.
   */
  export const get = fn(z.string(), async (name) => {
    try {
      return await Storage.read<TeamInfo>(configKey(name))
    } catch {
      return undefined
    }
  })

  /**
   * List all teams in this project.
   */
  export async function list(): Promise<TeamInfo[]> {
    try {
      const keys = await Storage.list(["team", Instance.project.id])
      return (await Promise.all(keys.map((key) => Storage.read<TeamInfo>(key).catch(() => undefined)))).filter(
        (t): t is TeamInfo => t !== undefined,
      )
    } catch {
      return []
    }
  }

  /**
   * Add a member to a team (atomic via Storage.update).
   * Rejects duplicate names (case-insensitive), duplicate sessionIDs, and "lead" as a name.
   */
  export async function addMember(teamName: string, member: TeamMember): Promise<void> {
    const lower = member.name.toLowerCase()
    if (lower === "lead") throw new Error(`Name "lead" is reserved and cannot be used for a teammate.`)

    await Storage.update<TeamInfo>(configKey(teamName), (draft) => {
      if (draft.members.some((m) => m.name.toLowerCase() === lower))
        throw new Error(`Teammate "${member.name}" already exists in team "${teamName}" (case-insensitive)`)
      if (draft.members.some((m) => m.sessionID === member.sessionID))
        throw new Error(`Session "${member.sessionID}" is already registered in team "${teamName}"`)
      draft.members.push(member)
    })

    log.info("member added", { teamName, member: member.name, agent: member.agent })
    await Bus.publish(TeamEvent.MemberSpawned, { teamName, member })
  }

  /**
   * Update a member's status atomically via Storage.update.
   * When options.guard is true, won't overwrite an existing "shutdown" status
   * (prevents TOCTOU race in notifyLead).
   */
  export async function setMemberStatus(
    teamName: string,
    memberName: string,
    status: MemberStatus,
    options?: { guard?: boolean },
  ): Promise<void> {
    try {
      await Storage.update<TeamInfo>(configKey(teamName), (draft) => {
        const member = draft.members.find((m) => m.name === memberName)
        if (!member) return
        if (options?.guard && member.status === "shutdown") return
        member.status = status
      })
    } catch {
      // Team was deleted between check and write — safe to ignore
      return
    }

    await Bus.publish(TeamEvent.MemberStatusChanged, { teamName, memberName, status })
  }

  /**
   * Toggle delegate mode on a team.
   */
  export async function setDelegate(teamName: string, delegate: boolean): Promise<void> {
    try {
      await Storage.update<TeamInfo>(configKey(teamName), (draft) => {
        draft.delegate = delegate
      })
    } catch {
      // Team not found — ignore
    }
  }

  /**
   * Update a member's plan approval status.
   */
  export async function setMemberPlanApproval(
    teamName: string,
    memberName: string,
    planApproval: "none" | "pending" | "approved" | "rejected",
  ): Promise<void> {
    try {
      await Storage.update<TeamInfo>(configKey(teamName), (draft) => {
        const member = draft.members.find((m) => m.name === memberName)
        if (!member) return
        member.planApproval = planApproval
      })
    } catch {
      // Team not found — ignore
    }
  }

  /**
   * Remove a member from a team.
   */
  export async function removeMember(teamName: string, memberName: string): Promise<void> {
    try {
      await Storage.update<TeamInfo>(configKey(teamName), (draft) => {
        draft.members = draft.members.filter((m) => m.name !== memberName)
      })
    } catch {
      // Team not found — ignore
    }
    log.info("member removed", { teamName, memberName })
  }

  /**
   * Find which team a session belongs to (as lead or member).
   */
  export async function findBySession(
    sessionID: string,
  ): Promise<{ team: TeamInfo; role: "lead" | "member"; memberName?: string } | undefined> {
    const teams = await list()
    for (const team of teams) {
      if (team.leadSessionID === sessionID) return { team, role: "lead" }
      const member = team.members.find((m) => m.sessionID === sessionID)
      if (member) return { team, role: "member", memberName: member.name }
    }
    return undefined
  }

  /**
   * Resolve the model for a teammate.
   * Priority: explicit model param > agent model > lead's last model > global default.
   * Returns `{ error }` if the explicit model is not found.
   */
  export async function resolveModel(input: {
    model?: string
    agent: { model?: { providerID: string; modelID: string } }
    messages: Array<{ info: { role: string; model?: { providerID: string; modelID: string } } }>
  }): Promise<{ providerID: string; modelID: string } | { error: string }> {
    const { Provider } = await import("../provider/provider")

    if (input.model) {
      const parsed = Provider.parseModel(input.model)
      try {
        await Provider.getModel(parsed.providerID, parsed.modelID)
      } catch (e: unknown) {
        if (Provider.ModelNotFoundError.isInstance(e)) {
          const hint = e.data.suggestions?.length ? ` Did you mean: ${e.data.suggestions.join(", ")}?` : ""
          return { error: `Model not found: ${input.model}.${hint}` }
        }
        throw e
      }
      return parsed
    }
    if (input.agent.model) return input.agent.model
    const lastUser = input.messages.findLast((m) => m.info.role === "user")
    if (lastUser?.info.model) return lastUser.info.model
    return await Provider.defaultModel()
  }

  /**
   * Spawn a teammate — creates session, registers member, starts prompt loop.
   * On addMember failure, cleans up the orphaned session.
   */
  export async function spawnMember(input: {
    teamName: string
    name: string
    parentSessionID: string
    agent: { name: string; prompt?: string; skills?: string[] }
    model: { providerID: string; modelID: string }
    prompt: string
    claimTask?: string
    planApproval: boolean
  }): Promise<{ sessionID: string; label: string }> {
    const { Session } = await import("../session")
    const { SessionPrompt } = await import("../session/prompt")
    const { Identifier } = await import("../id/id")
    const { Instance: Inst } = await import("../project/instance")
    const { TeamMessaging } = await import("./messaging")

    const label = `${input.model.providerID}/${input.model.modelID}`

    // Build permission rules for the child session
    const rules: Array<{ permission: string; pattern: string; action: "deny" | "allow" }> = [
      { permission: "team_create", pattern: "*", action: "deny" },
      { permission: "team_spawn", pattern: "*", action: "deny" },
      { permission: "team_shutdown", pattern: "*", action: "deny" },
      { permission: "team_cleanup", pattern: "*", action: "deny" },
      { permission: "team_approve_plan", pattern: "*", action: "deny" },
    ]
    if (input.planApproval) {
      // Pattern "*:plan-approval" is intentionally NOT "*" — PermissionNext.disabled() only
      // strips tools with pattern "*", so these remain visible to the model but are denied at
      // execution time. The ":plan-approval" tag lets approvePlan() remove only these rules.
      rules.push(
        ...WRITE_TOOLS.map((tool) => ({ permission: tool, pattern: "*:plan-approval", action: "deny" as const })),
      )
    }

    const session = await Session.createNext({
      parentID: input.parentSessionID,
      teammate: true,
      directory: Inst.directory,
      title: `${input.name} (@${input.agent.name} teammate, ${label})${input.planApproval ? " [plan mode]" : ""}`,
      permission: rules,
    })

    // Register member — if this fails, clean up the orphaned session
    try {
      await addMember(input.teamName, {
        name: input.name,
        sessionID: session.id,
        agent: input.agent.name,
        status: "active",
        prompt: input.prompt,
        model: label,
        planApproval: input.planApproval ? "pending" : "none",
      })
    } catch (err) {
      // Orphaned session cleanup
      try {
        await Session.remove(session.id)
      } catch {
        log.warn("failed to clean up orphaned session", { sessionID: session.id })
      }
      throw err
    }

    if (input.claimTask) {
      await TeamTasks.claim(input.teamName, input.claimTask, input.name).catch(() => {})
    }

    // Build teammate context message
    const planInstructions = input.planApproval
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

    const skillContext = input.agent.skills?.length
      ? [
          "",
          `Preloaded skills: ${input.agent.skills.join(", ")}`,
          "These skills are already loaded into your context — you do not need to invoke the skill tool for them.",
          "",
        ]
      : []

    const context = [
      `You are "${input.name}", a teammate in team "${input.teamName}".`,
      `Your agent type is "${input.agent.name}", using model ${label}.`,
      "",
      "Team tools available to you:",
      "- team_message: send a message to the lead or another teammate",
      "- team_broadcast: send a message to all teammates",
      "- team_tasks: view/add/complete tasks on the shared task list",
      "- team_claim: claim a pending task from the shared task list",
      "",
      "You do NOT have access to team_create, team_spawn, team_shutdown, or team_cleanup.",
      "Only the team lead can manage the team structure.",
      ...skillContext,
      ...planInstructions,
      "When you finish a task, mark it done with team_tasks and send a summary to the lead with team_message.",
      "You can message any teammate by name — not just the lead. Coordinate directly with peers when useful.",
      "",
      "SUBAGENT RELAY: If you use the task tool to spawn subagents, they CANNOT communicate with the team.",
      "You are responsible for relaying any relevant subagent findings via team_message or team_broadcast.",
      "",
      "IMPORTANT: Your plain text output is NOT visible to the team lead or other teammates.",
      "You MUST use team_message or team_broadcast to communicate. Just typing a response is not enough.",
      "",
      "Your instructions:",
      input.prompt,
    ].join("\n")

    const msgId = Identifier.ascending("message")
    await Session.updateMessage({
      id: msgId,
      sessionID: session.id,
      role: "user",
      agent: input.agent.name,
      model: input.model,
      time: { created: Date.now() },
    })
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: msgId,
      sessionID: session.id,
      type: "text",
      text: context,
    })

    // Fire-and-forget the teammate's prompt loop.
    // Wrapped in Promise.resolve().then() to guard against synchronous throws.
    log.info("spawning teammate", { teamName: input.teamName, name: input.name, sessionID: session.id })
    Promise.resolve()
      .then(() => SessionPrompt.loop({ sessionID: session.id }))
      .then(() => {
        log.info("teammate loop finished", { teamName: input.teamName, name: input.name })
        notifyLead(input.teamName, input.name, session.id, "finished")
      })
      .catch((err) => {
        log.warn("teammate loop error", { teamName: input.teamName, name: input.name, error: err.message })
        notifyLead(input.teamName, input.name, session.id, "errored", err.message)
      })

    return { sessionID: session.id, label }
  }

  /**
   * Approve or reject a teammate's plan. On approval, removes plan-approval
   * deny rules and notifies the teammate.
   */
  export async function approvePlan(input: {
    teamName: string
    memberName: string
    approved: boolean
    feedback?: string
  }): Promise<void> {
    const { Session } = await import("../session")
    const { TeamMessaging } = await import("./messaging")

    const team = await get(input.teamName)
    if (!team) throw new Error(`Team "${input.teamName}" not found`)

    const member = team.members.find((m) => m.name === input.memberName)
    if (!member) throw new Error(`Teammate "${input.memberName}" not found`)

    if (input.approved) {
      await Session.update(member.sessionID, (draft) => {
        if (draft.permission) {
          draft.permission = draft.permission.filter((rule) => rule.pattern !== "*:plan-approval")
        }
      })
      await setMemberPlanApproval(input.teamName, input.memberName, "approved")
      await TeamMessaging.send({
        teamName: input.teamName,
        from: "lead",
        to: input.memberName,
        text: input.feedback
          ? `Your plan has been APPROVED. You now have full write access. Feedback: ${input.feedback}`
          : "Your plan has been APPROVED. You now have full write access. Proceed with implementation.",
      })
    } else {
      await setMemberPlanApproval(input.teamName, input.memberName, "rejected")
      await TeamMessaging.send({
        teamName: input.teamName,
        from: "lead",
        to: input.memberName,
        text: `Your plan has been REJECTED. Please revise and resubmit. Feedback: ${input.feedback ?? "No specific feedback provided."}`,
      })
    }

    await Bus.publish(TeamEvent.PlanApproval, {
      teamName: input.teamName,
      memberName: input.memberName,
      approved: input.approved,
      feedback: input.feedback,
    })
  }

  /**
   * Notify the lead that a teammate's loop finished or errored.
   * Uses guard option because the lead may have already sent a shutdown request
   * (setting status to "shutdown") while the loop was finishing — without guard,
   * this would overwrite "shutdown" with "idle", preventing auto-cleanup.
   */
  async function notifyLead(
    teamName: string,
    name: string,
    sessionID: string,
    status: "finished" | "errored",
    error?: string,
  ) {
    try {
      const { TeamMessaging } = await import("./messaging")

      const team = await get(teamName)
      if (!team) return

      const member = team.members.find((m) => m.name === name)
      if (member?.status === "shutdown") return

      await setMemberStatus(teamName, name, "idle", { guard: true })
      await TeamMessaging.send({
        teamName,
        from: name,
        to: "lead",
        text:
          status === "finished"
            ? `I have finished my current work and am now idle. Review my session (${sessionID}) for detailed results. You can use team_shutdown to shut me down if no more work is needed.`
            : `I encountered an error and stopped: ${error ?? "unknown error"}. Review my session (${sessionID}). You can use team_shutdown to shut me down, or send me a message to retry.`,
      })
    } catch (err: unknown) {
      log.warn("failed to notify lead of teammate completion", {
        teamName,
        name,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Clean up a team — removes config and task data.
   * Fails if any members are still active.
   * Publishes TeamEvent.Cleaned so listeners can handle side-effects
   * (e.g. restoring lead session permissions).
   */
  export async function cleanup(teamName: string): Promise<void> {
    const team = await get(teamName)
    if (!team) throw new Error(`Team "${teamName}" not found`)

    const alive = team.members.filter((m) => m.status === "active" || m.status === "interrupted")
    if (alive.length > 0) {
      throw new Error(
        `Cannot clean up team "${teamName}": ${alive.length} active/interrupted member(s): ${alive.map((m) => m.name).join(", ")}. Shut them down first.`,
      )
    }

    await Storage.remove(configKey(teamName))
    await Storage.remove(tasksKey(teamName))

    log.info("team cleaned up", { teamName })
    await Bus.publish(TeamEvent.Cleaned, {
      teamName,
      leadSessionID: team.leadSessionID,
      delegate: !!team.delegate,
    })
  }

  /**
   * Cancel a single teammate's prompt loop by calling SessionPrompt.cancel.
   * This mirrors how the Task tool propagates abort to subagents (task.ts:121-125).
   * Returns true if the member was found and cancelled.
   */
  export async function cancelMember(teamName: string, memberName: string): Promise<boolean> {
    const { SessionPrompt } = await import("../session/prompt")

    const team = await get(teamName)
    if (!team) return false

    const member = team.members.find((m) => m.name === memberName)
    if (!member) return false
    if (member.status !== "active") return false

    log.info("cancelling member", { teamName, memberName, sessionID: member.sessionID })
    SessionPrompt.cancel(member.sessionID)
    return true
  }

  /**
   * Cancel all active teammates' prompt loops.
   * Returns the count of members that were cancelled.
   */
  export async function cancelAllMembers(teamName: string): Promise<number> {
    const { SessionPrompt } = await import("../session/prompt")

    const team = await get(teamName)
    if (!team) return 0

    let count = 0
    for (const member of team.members) {
      if (member.status !== "active") continue
      log.info("cancelling member", { teamName, memberName: member.name, sessionID: member.sessionID })
      SessionPrompt.cancel(member.sessionID)
      count++
    }
    return count
  }

  /**
   * Mark teammates that were active when the server died as "interrupted"
   * and inject a notification into the lead session.
   * Called once during InstanceBootstrap.
   */
  export async function recover(): Promise<{ interrupted: number }> {
    const teams = await list()
    let count = 0

    for (const team of teams) {
      const active = team.members.filter((m) => m.status === "active")
      if (active.length === 0) continue

      log.info("marking interrupted teammates", { teamName: team.name, count: active.length })

      const names: string[] = []
      for (const member of active) {
        await setMemberStatus(team.name, member.name, "interrupted")
        names.push(member.name)
        count++
      }

      try {
        const { Session } = await import("../session")
        const { Identifier } = await import("../id/id")
        const msgs = await Session.messages({ sessionID: team.leadSessionID })
        const lastUser = msgs.findLast((m) => m.info.role === "user")
        if (lastUser) {
          const info = lastUser.info as { agent: string; model: { providerID: string; modelID: string } }
          const msgId = Identifier.ascending("message")
          await Session.updateMessage({
            id: msgId,
            sessionID: team.leadSessionID,
            role: "user",
            agent: info.agent,
            model: info.model,
            time: { created: Date.now() },
          })
          await Session.updatePart({
            id: Identifier.ascending("part"),
            messageID: msgId,
            sessionID: team.leadSessionID,
            type: "text",
            text: `[System]: Server was restarted. The following teammates in team "${team.name}" were interrupted and need to be resumed: ${names.join(", ")}. Use team_message or team_broadcast to tell them to continue their work.`,
            synthetic: true,
          })
        }
      } catch (err: unknown) {
        log.warn("failed to notify lead of interrupted teammates", {
          teamName: team.name,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    if (count > 0) log.info("team recovery complete", { interrupted: count })
    return { interrupted: count }
  }
}

export namespace TeamTasks {
  /**
   * Read all tasks for a team.
   */
  export async function list(teamName: string): Promise<TeamTask[]> {
    try {
      return await Storage.read<TeamTask[]>(tasksKey(teamName))
    } catch {
      return []
    }
  }

  /**
   * Write the full task list for a team (replaces).
   */
  export async function update(teamName: string, tasks: TeamTask[]): Promise<void> {
    const resolved = resolveDependencies(tasks)
    await Storage.write(tasksKey(teamName), resolved)
    await Bus.publish(TeamEvent.TaskUpdated, { teamName, tasks: resolved })
  }

  /**
   * Add tasks to the team's task list.
   */
  export async function add(teamName: string, newTasks: TeamTask[]): Promise<void> {
    const existing = await list(teamName)
    const resolved = resolveDependencies([...existing, ...newTasks])
    await Storage.write(tasksKey(teamName), resolved)
    await Bus.publish(TeamEvent.TaskUpdated, { teamName, tasks: resolved })
  }

  /**
   * Atomically claim a task. Returns true if claimed, false if already taken.
   */
  export async function claim(teamName: string, taskId: string, memberName: string): Promise<boolean> {
    let claimed = false
    try {
      await Storage.update<TeamTask[]>(tasksKey(teamName), (tasks) => {
        const task = tasks.find((t) => t.id === taskId)
        if (!task) return
        if (task.status !== "pending") return
        if (task.assignee) return

        if (task.depends_on?.length) {
          const unresolved = task.depends_on.some((depId) => {
            const dep = tasks.find((t) => t.id === depId)
            return !dep || (dep.status !== "completed" && dep.status !== "cancelled")
          })
          if (unresolved) return
        }

        task.status = "in_progress"
        task.assignee = memberName
        claimed = true
      })
    } catch {
      return false
    }

    if (claimed) await Bus.publish(TeamEvent.TaskClaimed, { teamName, taskId, memberName })
    return claimed
  }

  /**
   * Mark a task as completed.
   */
  export async function complete(teamName: string, taskId: string): Promise<void> {
    let tasks: TeamTask[] = []
    try {
      tasks = await Storage.update<TeamTask[]>(tasksKey(teamName), (draft) => {
        const task = draft.find((t) => t.id === taskId)
        if (task) task.status = "completed"
        const resolved = resolveDependencies(draft)
        // Mutate in-place — Storage.update serializes the original reference,
        // so reassignment (draft = resolved) wouldn't propagate
        draft.length = 0
        draft.push(...resolved)
      })
    } catch {
      return
    }
    await Bus.publish(TeamEvent.TaskUpdated, { teamName, tasks })
  }

  function resolveDependencies(tasks: TeamTask[]): TeamTask[] {
    const validIds = new Set(tasks.map((t) => t.id))

    return tasks.map((task) => {
      if (task.depends_on) {
        task = { ...task, depends_on: task.depends_on.filter((id) => validIds.has(id)) }
      }
      if (!task.depends_on?.length) return task

      const unresolved = task.depends_on.some((depId) => {
        const dep = tasks.find((t) => t.id === depId)
        return !dep || (dep.status !== "completed" && dep.status !== "cancelled")
      })

      if (unresolved && task.status === "pending") return { ...task, status: "blocked" }
      if (!unresolved && task.status === "blocked") return { ...task, status: "pending" }
      return task
    })
  }
}
