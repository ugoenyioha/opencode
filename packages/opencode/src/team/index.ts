import z from "zod"
import { Log } from "../util/log"
import { Bus } from "../bus"
import { Instance } from "../project/instance"
import { Database, and, eq, inArray, isNull } from "../storage/db"
import { fn } from "../util/fn"
import { Identifier } from "../id/id"
import { TeamTable, TeamTaskTable } from "./team.sql"
import { SessionTable } from "../session/session.sql"
import { Config } from "../config/config"
import {
  TeamEvent,
  MemberStatus as MemberStatusSchema,
  ExecutionStatus,
  TeamInfoSchema,
  TeamTaskSchema,
  type TeamInfo,
  type TeamMember,
  type TeamTask,
  type MemberStatus,
  type ExecutionStatus as ExecutionStatusType,
} from "./events"

export {
  TeamEvent,
  ExecutionStatus,
  TeamInfoSchema,
  TeamTaskSchema,
  type TeamInfo,
  type TeamMember,
  type TeamTask,
} from "./events"

/** Write tools that are denied during plan-approval or delegate mode */
export const WRITE_TOOLS = ["bash", "write", "edit", "multiedit", "apply_patch"] as const

const log = Log.create({ service: "team" })

const TERMINAL_EXECUTION_STATES = new Set<ExecutionStatusType>([
  "idle",
  "cancelled",
  "completed",
  "failed",
  "timed_out",
])

const MEMBER_TRANSITIONS: Record<MemberStatus, MemberStatus[]> = {
  ready: ["busy", "shutdown_requested", "shutdown", "error"],
  busy: ["ready", "shutdown_requested", "error"],
  shutdown_requested: ["shutdown", "error"],
  shutdown: [],
  error: ["ready", "shutdown_requested", "shutdown"],
}

const EXECUTION_TRANSITIONS: Record<ExecutionStatusType, ExecutionStatusType[]> = {
  idle: ["starting"],
  starting: ["running", "cancel_requested", "cancelling", "failed", "timed_out"],
  running: ["cancel_requested", "cancelling", "completing", "failed", "timed_out"],
  cancel_requested: ["cancelling", "cancelled", "failed", "timed_out"],
  cancelling: ["cancelled", "failed", "timed_out"],
  cancelled: ["idle"],
  completing: ["completed", "failed", "timed_out"],
  completed: ["idle"],
  failed: ["idle"],
  timed_out: ["idle"],
}

function normalizeMember(member: TeamMember): TeamMember {
  const status = MemberStatusSchema.parse(member.status)
  const execution_status = ExecutionStatus.safeParse(member.execution_status).success
    ? member.execution_status
    : status === "busy"
      ? "running"
      : "idle"
  return {
    ...member,
    status,
    execution_status,
  }
}

function normalizeTeam(team: TeamInfo): TeamInfo {
  return {
    ...team,
    members: team.members.map(normalizeMember),
  }
}

function parseMeta(session: typeof SessionTable.$inferSelect): TeamMember | undefined {
  if (!session.team_meta) return
  const meta = session.team_meta
  if (typeof meta.name !== "string" || typeof meta.agent !== "string" || typeof meta.status !== "string") return
  const execution = ExecutionStatus.safeParse(meta.execution_status)
  const member: TeamMember = {
    name: meta.name,
    sessionID: session.id,
    agent: meta.agent,
    status: MemberStatusSchema.parse(meta.status),
    execution_status: execution.success ? execution.data : undefined,
    prompt: meta.prompt,
    model: meta.model,
    planApproval:
      session.plan_approval === "none" ||
      session.plan_approval === "pending" ||
      session.plan_approval === "approved" ||
      session.plan_approval === "rejected"
        ? session.plan_approval
        : undefined,
  }
  return normalizeMember(member)
}

function sessionMeta(member: TeamMember) {
  return {
    name: member.name,
    agent: member.agent,
    status: member.status,
    execution_status: member.execution_status,
    prompt: member.prompt,
    model: member.model,
  }
}

function loadTeam(name: string) {
  const team = Database.use((db) =>
    db
      .select()
      .from(TeamTable)
      .where(
        and(eq(TeamTable.project_id, Instance.project.id), eq(TeamTable.name, name), eq(TeamTable.status, "active")),
      )
      .get(),
  )
  if (!team) return
  const sessions = Database.use((db) =>
    db
      .select()
      .from(SessionTable)
      .where(and(eq(SessionTable.team_id, team.id), eq(SessionTable.team_role, "member")))
      .all(),
  )
  return normalizeTeam({
    name: team.name,
    leadSessionID: team.lead_session_id,
    members: sessions.map(parseMeta).filter((x): x is TeamMember => !!x),
    created: team.time_created,
    updated: team.time_updated,
    delegate: !!team.delegate,
  })
}

function teamID(name: string) {
  return Database.use((db) =>
    db
      .select({ id: TeamTable.id })
      .from(TeamTable)
      .where(
        and(eq(TeamTable.project_id, Instance.project.id), eq(TeamTable.name, name), eq(TeamTable.status, "active")),
      )
      .get(),
  )?.id
}

function canTransition<T extends string>(current: T, next: T, map: Record<T, T[]>) {
  if (current === next) return true
  return map[current]?.includes(next) === true
}

function teamId() {
  return `tm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Core team lifecycle management.
 * Handles creation, member spawning, status transitions, cleanup, recovery, and timeouts.
 */
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
   * Periodically enforces global team lifespan and idle timeouts.
   * Timed-out teams have all members moved to shutdown_requested and cancelled.
   */
  export function enforceTimeouts(): () => void {
    const interval = setInterval(
      () => {
        Promise.resolve()
          .then(async () => {
            const config = await Config.get()
            const lifespan = config.server?.limits?.team_max_lifespan ?? 6 * 60 * 60 * 1000
            const idle = config.server?.limits?.team_idle_timeout ?? 60 * 60 * 1000
            const now = Date.now()
            const teams = await list()

            for (const team of teams) {
              const last = team.updated ?? team.created
              const hitLifespan = now - team.created > lifespan
              const hitIdle = now - last > idle
              if (!hitLifespan && !hitIdle) continue

              log.warn("team timeout reached, requesting shutdown", {
                teamName: team.name,
                reason: hitLifespan ? "lifespan" : "idle",
                lifespanMs: now - team.created,
                idleMs: now - last,
                teamMaxLifespan: lifespan,
                teamIdleTimeout: idle,
              })

              await cancelAllMembers(team.name)
              for (const member of team.members) {
                if (member.status === "shutdown") continue
                await transitionMemberStatus(team.name, member.name, "shutdown_requested", { force: true })
              }
            }
          })
          .catch((error) => {
            log.warn("team timeout enforcer tick failed", {
              error: error instanceof Error ? error.message : String(error),
            })
          })
      },
      5 * 60 * 1000,
    )

    return () => clearInterval(interval)
  }

  /**
   * Listen for TeamEvent.Cleaned and restore session permissions.
   * This decouples the team module from the session module —
   * cleanup only publishes the event, this listener handles session side-effects.
   */
  export function onCleanedRestorePermissions(): () => void {
    return Bus.subscribe(TeamEvent.Cleaned, async (event) => {
      if (!event.properties.delegate) return
      if (!event.properties.leadSessionID) return

      try {
        const { Session } = await import("../session")
        const info = await Session.get(event.properties.leadSessionID)
        await Session.setPermission({
          sessionID: event.properties.leadSessionID,
          permission: (info.permission ?? []).filter(
            (rule) => !((WRITE_TOOLS as readonly string[]).includes(rule.permission) && rule.action === "deny"),
          ),
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

      const config = await Config.get()
      const limit = config.server?.limits?.max_teams ?? 50
      const active = Database.use(
        (db) =>
          db
            .select({ id: TeamTable.id })
            .from(TeamTable)
            .where(and(eq(TeamTable.project_id, Instance.project.id), eq(TeamTable.status, "active")))
            .all().length,
      )
      if (active >= limit) {
        throw new Error(
          `Cannot create team: maximum number of concurrent teams (${limit}) reached. Clean up existing teams first.`,
        )
      }

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

      const id = teamId()
      Database.use((db) => {
        db.insert(TeamTable)
          .values({
            id,
            project_id: Instance.project.id,
            name: input.name,
            lead_session_id: input.leadSessionID,
            delegate: !!input.delegate,
            status: "active",
            time_created: team.created,
            time_updated: team.created,
          })
          .run()
        db.update(SessionTable)
          .set({
            team_id: id,
            team_role: "lead",
            plan_approval: "none",
            team_meta: null,
            time_updated: Date.now(),
          })
          .where(eq(SessionTable.id, input.leadSessionID))
          .run()
      })

      log.info("team created", { name: input.name, leadSessionID: input.leadSessionID })
      await Bus.publish(TeamEvent.Created, { team })
      return team
    },
  )

  /**
   * Get a team by name. Returns undefined if not found.
   */
  export const get = fn(z.string(), async (name) => {
    return loadTeam(name)
  })

  /**
   * List all teams in this project.
   */
  export async function list(): Promise<TeamInfo[]> {
    const teams = Database.use((db) =>
      db
        .select()
        .from(TeamTable)
        .where(and(eq(TeamTable.project_id, Instance.project.id), eq(TeamTable.status, "active")))
        .all(),
    )
    if (!teams.length) return []
    const ids = teams.map((x) => x.id)
    const sessions = Database.use((db) =>
      db
        .select()
        .from(SessionTable)
        .where(and(inArray(SessionTable.team_id, ids), eq(SessionTable.team_role, "member")))
        .all(),
    )
    const grouped = sessions.reduce(
      (acc, item) => {
        if (!item.team_id) return acc
        const meta = parseMeta(item)
        if (!meta) return acc
        acc[item.team_id] = [...(acc[item.team_id] ?? []), meta]
        return acc
      },
      {} as Record<string, TeamMember[]>,
    )
    return teams.map((team) =>
      normalizeTeam({
        name: team.name,
        leadSessionID: team.lead_session_id,
        members: grouped[team.id] ?? [],
        created: team.time_created,
        updated: team.time_updated,
        delegate: !!team.delegate,
      }),
    )
  }

  /** Update the team's `time_updated` timestamp on any activity (prevents idle timeout) */
  export function touch(teamName: string) {
    const id = teamID(teamName)
    if (!id) return
    Database.use((db) => {
      db.update(TeamTable).set({ time_updated: Date.now() }).where(eq(TeamTable.id, id)).run()
    })
  }

  /**
   * Add a member to a team via session/team_meta persistence.
   * Rejects duplicate names (case-insensitive), duplicate sessionIDs, and "lead" as a name.
   */
  export async function addMember(teamName: string, member: TeamMember): Promise<void> {
    const lower = member.name.toLowerCase()
    if (lower === "lead") throw new Error(`Name "lead" is reserved and cannot be used for a teammate.`)

    const team = await get(teamName)
    if (!team) throw new Error(`Team "${teamName}" not found`)
    if (team.members.some((m) => m.name.toLowerCase() === lower))
      throw new Error(`Teammate "${member.name}" already exists in team "${teamName}" (case-insensitive)`)
    if (team.members.some((m) => m.sessionID === member.sessionID))
      throw new Error(`Session "${member.sessionID}" is already registered in team "${teamName}"`)
    const id = teamID(teamName)
    if (!id) throw new Error(`Team "${teamName}" not found`)
    Database.use((db) => {
      db.update(SessionTable)
        .set({
          team_id: id,
          team_role: "member",
          team_meta: sessionMeta(member),
          plan_approval: member.planApproval ?? "none",
          time_updated: Date.now(),
        })
        .where(eq(SessionTable.id, member.sessionID))
        .run()
    })

    log.info("member added", { teamName, member: member.name, agent: member.agent })
    await Bus.publish(TeamEvent.MemberSpawned, { teamName, member })
  }

  /**
   * Validate and apply a member status transition.
   * Returns false if the transition is invalid or the member is not found.
   * Auto-completes in_progress tasks when a member shuts down.
   */
  export async function transitionMemberStatus(
    teamName: string,
    memberName: string,
    status: MemberStatus,
    options?: { guard?: boolean; force?: boolean },
  ): Promise<boolean> {
    const team = await get(teamName)
    const member = team?.members.find((m) => m.name === memberName)
    if (!team || !member) return false
    if (options?.guard && member.status === "shutdown") return false
    const from = member.status
    if (!options?.force && !canTransition(from, status, MEMBER_TRANSITIONS)) return false
    if (from === status) return false
    const meta = { ...sessionMeta(member), status }
    Database.use((db) => {
      db.update(SessionTable)
        .set({ team_meta: meta, time_updated: Date.now() })
        .where(eq(SessionTable.id, member.sessionID))
        .run()
    })
    const changed = true
    if (!changed) return false
    await Bus.publish(TeamEvent.MemberStatusChanged, { teamName, memberName, status })

    // When a member shuts down, auto-complete any in_progress tasks assigned
    // to them. LLMs frequently forget to call team_tasks complete before
    // shutting down, leaving the task board stale.
    if (status === "shutdown") {
      try {
        const tasks = await TeamTasks.list(teamName)
        for (const task of tasks) {
          if (task.status === "in_progress" && task.assignee === memberName) {
            await TeamTasks.complete(teamName, task.id)
            log.info("auto-completed task on member shutdown", { teamName, memberName, taskId: task.id })
          }
        }
      } catch {
        // Task auto-completion is best-effort — don't fail the transition
      }
    }

    return true
  }

  /** Validate and apply an execution status transition within a member's prompt loop */
  export async function transitionExecutionStatus(
    teamName: string,
    memberName: string,
    status: ExecutionStatusType,
    options?: { force?: boolean },
  ): Promise<boolean> {
    const team = await get(teamName)
    const member = team?.members.find((m) => m.name === memberName)
    if (!team || !member) return false
    const from = normalizeMember(member).execution_status ?? "idle"
    if (!options?.force && !canTransition(from, status, EXECUTION_TRANSITIONS)) return false
    if (from === status) return false
    const meta = { ...sessionMeta(member), execution_status: status }
    Database.use((db) => {
      db.update(SessionTable)
        .set({ team_meta: meta, time_updated: Date.now() })
        .where(eq(SessionTable.id, member.sessionID))
        .run()
    })
    const changed = true
    if (!changed) return false
    await Bus.publish(TeamEvent.MemberExecutionChanged, { teamName, memberName, status })
    return true
  }

  /**
   * Backward-compatible setter for tests and call sites that need direct status updates.
   */
  export async function setMemberStatus(
    teamName: string,
    memberName: string,
    status: MemberStatus,
    options?: { guard?: boolean },
  ): Promise<void> {
    await transitionMemberStatus(teamName, memberName, status, { guard: options?.guard, force: true })
  }

  /**
   * Toggle delegate mode on a team.
   */
  export async function setDelegate(teamName: string, delegate: boolean): Promise<void> {
    const id = teamID(teamName)
    if (!id) return
    Database.use((db) => {
      db.update(TeamTable).set({ delegate, time_updated: Date.now() }).where(eq(TeamTable.id, id)).run()
    })
  }

  /**
   * Update a member's plan approval status.
   */
  export async function setMemberPlanApproval(
    teamName: string,
    memberName: string,
    planApproval: "none" | "pending" | "approved" | "rejected",
  ): Promise<void> {
    const team = await get(teamName)
    const member = team?.members.find((m) => m.name === memberName)
    if (!member) return
    Database.use((db) => {
      db.update(SessionTable)
        .set({ plan_approval: planApproval, time_updated: Date.now() })
        .where(eq(SessionTable.id, member.sessionID))
        .run()
    })
  }

  /**
   * Remove a member from a team.
   */
  export async function removeMember(teamName: string, memberName: string): Promise<void> {
    const team = await get(teamName)
    const member = team?.members.find((m) => m.name === memberName)
    if (member) {
      Database.use((db) => {
        db.update(SessionTable)
          .set({ team_id: null, team_role: null, team_meta: null, plan_approval: null, time_updated: Date.now() })
          .where(eq(SessionTable.id, member.sessionID))
          .run()
      })
    }
    log.info("member removed", { teamName, memberName })
  }

  /**
   * Find which team a session belongs to (as lead or member).
   */
  export async function findBySession(
    sessionID: string,
  ): Promise<{ team: TeamInfo; role: "lead" | "member"; memberName?: string } | undefined> {
    const session = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get())
    if (session?.team_id && session.team_role) {
      const tid = session.team_id
      const teamRow = Database.use((db) =>
        db
          .select({ name: TeamTable.name })
          .from(TeamTable)
          .where(
            and(eq(TeamTable.id, tid), eq(TeamTable.project_id, Instance.project.id), eq(TeamTable.status, "active")),
          )
          .get(),
      )
      if (teamRow) {
        const team = await get(teamRow.name)
        if (team) {
          if (session.team_role === "lead") return { team, role: "lead" }
          const memberName = typeof session.team_meta?.name === "string" ? session.team_meta.name : undefined
          return { team, role: "member", ...(memberName ? { memberName } : {}) }
        }
      }
    }

    const teams = await list()
    for (const team of teams) {
      if (team.leadSessionID === sessionID) return { team, role: "lead" }
      const member = team.members.find((m) => m.sessionID === sessionID)
      if (member) return { team, role: "member", memberName: member.name }
    }

    // Fallback: lead rebind. If the caller is a non-teammate root session and
    // there's a team whose original lead session no longer exists, rebind the
    // lead to this session. This handles the case where the user starts a new
    // session after the original lead session was deleted, or the sidecar creates
    // a new session for a resumed invocation.
    // Conditions: exactly one team (unambiguous), original lead session is gone,
    // caller is a root non-teammate session.
    if (teams.length === 1) {
      try {
        const { Session } = await import("../session")
        const session = await Session.get(sessionID)
        if (session && !session.parentID && !session.teammate) {
          const team = teams[0]
          const leadExists = team.leadSessionID
            ? await Session.get(team.leadSessionID).catch(() => undefined)
            : undefined
          if (!leadExists) {
            log.info("rebinding lead — original lead session is gone", {
              teamName: team.name,
              oldLead: team.leadSessionID,
              newLead: sessionID,
            })
            await rebindLead(team.name, sessionID, "findBySession: original lead session gone")
            return { team: { ...team, leadSessionID: sessionID }, role: "lead" }
          }
        }
      } catch {
        // Session module may not be loaded — safe to ignore
      }
    }

    return undefined
  }

  /**
   * Rebind a team's lead session to a new session ID.
   * Used when the original lead session is no longer available (e.g. after
   * a restart where the user starts a new session instead of continuing the old one).
   */
  export async function rebindLead(teamName: string, newSessionID: string, reason?: string): Promise<void> {
    const id = teamID(teamName)
    if (!id) return
    const previous = await get(teamName)
    log.info("rebinding lead session", {
      teamName,
      oldSessionID: previous?.leadSessionID,
      newSessionID,
      reason: reason ?? "unspecified",
    })
    Database.use((db) => {
      db.update(TeamTable)
        .set({ lead_session_id: newSessionID, time_updated: Date.now() })
        .where(eq(TeamTable.id, id))
        .run()
      db.update(SessionTable)
        .set({ team_id: id, team_role: "lead", plan_approval: "none", team_meta: null, time_updated: Date.now() })
        .where(eq(SessionTable.id, newSessionID))
        .run()
    })
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
      const parsed = Provider.parseModel(await Provider.resolveModel(input.model))
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
    agent: { name: string; prompt?: string; skills?: string[]; isolation?: "none" | "worktree" }
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
    const { Worktree } = await import("../worktree")

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
      // Use pattern "*" so that PermissionNext.evaluate() and disabled() both
      // correctly deny/hide write tools.  On approval, these rules are removed
      // by matching (permission ∈ WRITE_TOOLS && pattern === "*" && action === "deny").
      rules.push(...WRITE_TOOLS.map((tool) => ({ permission: tool, pattern: "*", action: "deny" as const })))
    }

    const sessionID = Identifier.ascending("session")
    let directory = Inst.directory

    if (input.agent.isolation === "worktree") {
      try {
        const worktree = await Worktree.create({ name: sessionID })
        directory = worktree.directory
      } catch (err) {
        log.warn("failed to create worktree for isolated teammate, falling back to standard directory", { error: err })
      }
    }

    const session = await Session.createNext({
      id: sessionID,
      parentID: input.parentSessionID,
      teammate: true,
      directory,
      title: `${input.name} (@${input.agent.name} teammate, ${label})${input.planApproval ? " [plan mode]" : ""}`,
      permission: rules,
    })

    // Register member — if this fails, clean up the orphaned session
    try {
      await addMember(input.teamName, {
        name: input.name,
        sessionID: session.id,
        agent: input.agent.name,
        status: "busy",
        execution_status: "idle",
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
      "- team_status: get a snapshot of the full team state (members, tasks, unread messages)",
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

    await transitionMemberStatus(input.teamName, input.name, "busy")
    await transitionExecutionStatus(input.teamName, input.name, "starting")

    // Fire-and-forget the teammate's prompt loop.
    // Wrapped in Promise.resolve().then() to guard against synchronous throws.
    log.info("spawning teammate", { teamName: input.teamName, name: input.name, sessionID: session.id })
    Promise.resolve()
      .then(async () => {
        await transitionExecutionStatus(input.teamName, input.name, "running")
        return SessionPrompt.loop({ sessionID: session.id })
      })
      .then(async (result) => {
        const team = await get(input.teamName)
        const member = team?.members.find((m) => m.name === input.name)
        const reason = member?.status === "shutdown_requested" ? "cancelled" : "completed"
        log.info("teammate loop ended", { teamName: input.teamName, name: input.name, reason })
        if (reason === "completed") {
          await transitionExecutionStatus(input.teamName, input.name, "completing")
          await transitionExecutionStatus(input.teamName, input.name, "completed")
        }
        if (reason === "cancelled") {
          await transitionExecutionStatus(input.teamName, input.name, "cancelling")
          await transitionExecutionStatus(input.teamName, input.name, "cancelled")
        }
        await transitionExecutionStatus(input.teamName, input.name, "idle")
        const refreshed = await get(input.teamName)
        const next = refreshed?.members.find((m) => m.name === input.name)
        if (next?.status === "shutdown_requested") {
          await transitionMemberStatus(input.teamName, input.name, "shutdown")
        } else {
          await transitionMemberStatus(input.teamName, input.name, "ready")
          await Bus.publish(TeamEvent.TeammateIdle, {
            teamName: input.teamName,
            memberName: input.name,
            reason,
          })
        }
        await notifyLead(input.teamName, input.name, session.id, reason)
      })
      .catch(async (err) => {
        log.warn("teammate loop error", { teamName: input.teamName, name: input.name, error: err.message })
        await transitionExecutionStatus(input.teamName, input.name, "failed")
        await transitionExecutionStatus(input.teamName, input.name, "idle")
        await transitionMemberStatus(input.teamName, input.name, "error")
        await notifyLead(input.teamName, input.name, session.id, "errored", err.message)
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
      const info = await Session.get(member.sessionID)
      await Session.setPermission({
        sessionID: member.sessionID,
        permission: (info.permission ?? []).filter(
          (rule) =>
            !(
              (WRITE_TOOLS as readonly string[]).includes(rule.permission) &&
              rule.pattern === "*" &&
              rule.action === "deny"
            ),
        ),
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
   * this would overwrite "shutdown" with "ready", preventing auto-cleanup.
   */
  async function notifyLead(
    teamName: string,
    name: string,
    sessionID: string,
    status: "completed" | "cancelled" | "errored",
    error?: string,
  ) {
    try {
      const { TeamMessaging } = await import("./messaging")

      const team = await get(teamName)
      if (!team) return

      const member = team.members.find((m) => m.name === name)
      if (member?.status === "shutdown") return

      const text =
        status === "cancelled"
          ? `I was interrupted by the lead and am now idle. Send me a message to resume work.`
          : status === "completed"
            ? `I have finished my current work and am now idle. Review my session (${sessionID}) for detailed results. You can use team_shutdown to shut me down if no more work is needed.`
            : `I encountered an error and stopped: ${error ?? "unknown error"}. Review my session (${sessionID}). You can use team_shutdown to shut me down, or send me a message to retry.`

      await TeamMessaging.send({
        teamName,
        from: name,
        to: "lead",
        text,
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
    let team = await get(teamName)
    if (!team) throw new Error(`Team "${teamName}" not found`)

    // Wait briefly for shutdown_requested members to transition to shutdown.
    // The auto-wake .then() handler does this transition when the loop ends,
    // but there's a race window between the lead calling cleanup and the
    // async transition completing.
    const pending = team.members.filter((m) => m.status === "shutdown_requested")
    if (pending.length > 0) {
      for (let attempt = 0; attempt < 5; attempt++) {
        await Bun.sleep(200)
        team = await get(teamName)
        if (!team) throw new Error(`Team "${teamName}" not found`)
        if (team.members.every((m) => m.status === "shutdown")) break
      }
      // Force-transition any still-pending members — their loop likely already
      // ended but the async .then() handler lost the race.
      for (const member of team.members) {
        if (member.status === "shutdown_requested") {
          log.info("force-transitioning shutdown_requested member during cleanup", {
            teamName,
            memberName: member.name,
          })
          await transitionMemberStatus(teamName, member.name, "shutdown", { force: true })
        }
      }
      // Re-read after force transitions
      team = await get(teamName)
      if (!team) throw new Error(`Team "${teamName}" not found`)
    }

    const alive = team.members.filter((m) => m.status !== "shutdown")
    if (alive.length > 0) {
      throw new Error(
        `Cannot clean up team "${teamName}": ${alive.length} non-shutdown member(s): ${alive.map((m) => m.name).join(", ")}. Shut them down first.`,
      )
    }

    const { SessionPrompt } = await import("../session/prompt")

    // If any teammate loop is still unwinding, cancel it explicitly and wait
    // for execution to reach a terminal state before removing worktrees.
    for (const member of team.members) {
      if (TERMINAL_EXECUTION_STATES.has(member.execution_status ?? "idle")) continue
      log.info("cleanup cancelling still-running teammate", {
        teamName,
        memberName: member.name,
        sessionID: member.sessionID,
        execution_status: member.execution_status,
      })
      SessionPrompt.cancel(member.sessionID)
      await transitionExecutionStatus(teamName, member.name, "cancelling", { force: true })
    }

    // A member can reach shutdown status slightly before its prompt loop has
    // fully unwound. Removing its worktree too early can race any late shell/
    // prompt cleanup that still uses the teammate cwd.
    for (let attempt = 0; attempt < 25; attempt++) {
      const refreshed = await get(teamName)
      if (!refreshed) throw new Error(`Team "${teamName}" not found`)
      if (refreshed.members.every((m) => TERMINAL_EXECUTION_STATES.has(m.execution_status ?? "idle"))) {
        team = refreshed
        break
      }
      await Bun.sleep(120)
      team = refreshed
    }

    const { Inbox } = await import("./inbox")
    await Inbox.removeAll(
      teamName,
      team.members.map((m) => m.name),
    )

    const { Session } = await import("../session")
    const { Worktree } = await import("../worktree")
    const { Instance: Inst } = await import("../project/instance")

    for (const member of team.members) {
      try {
        const session = await Session.get(member.sessionID)
        if (session.directory && session.directory !== Inst.directory) {
          await Worktree.remove({ directory: session.directory })
        }
      } catch (err) {
        log.warn("failed to clean up worktree for teammate", { memberName: member.name, error: err })
      }
    }

    const id = teamID(teamName)
    if (id) {
      Database.use((db) => {
        db.update(SessionTable)
          .set({ team_id: null, team_role: null, team_meta: null, plan_approval: null, time_updated: Date.now() })
          .where(eq(SessionTable.team_id, id))
          .run()
        db.delete(TeamTable).where(eq(TeamTable.id, id)).run()
      })
    }

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
    const { SessionStatus } = await import("../session/status")

    const team = await get(teamName)
    if (!team) return false

    const member = team.members.find((m) => m.name === memberName)
    if (!member) return false
    // Allow cancel for busy members and shutdown_requested members
    // (shutdown sets shutdown_requested before calling cancelMember,
    // so the member is no longer "busy" by the time we get here)
    if (member.status !== "busy" && member.status !== "shutdown_requested") return false
    if (TERMINAL_EXECUTION_STATES.has(member.execution_status ?? "idle")) return false

    log.info("cancelling member", { teamName, memberName, sessionID: member.sessionID })
    await transitionExecutionStatus(teamName, memberName, "cancel_requested")

    for (const _ of [0, 1, 2]) {
      SessionPrompt.cancel(member.sessionID)
      await transitionExecutionStatus(teamName, memberName, "cancelling")
      await Bun.sleep(120)
      const next = await get(teamName)
      const current = next?.members.find((m) => m.name === memberName)
      if (!current) break
      if (TERMINAL_EXECUTION_STATES.has(current.execution_status ?? "idle")) break
      if (current.status !== "busy" && current.status !== "shutdown_requested") break
    }

    const next = await get(teamName)
    const current = next?.members.find((m) => m.name === memberName)
    if (!current) return true
    if (TERMINAL_EXECUTION_STATES.has(current.execution_status ?? "idle")) return true

    const runtime = await SessionStatus.get(member.sessionID)
    if (runtime.type !== "idle") return false

    await transitionExecutionStatus(teamName, memberName, "cancelled", { force: true })
    await transitionExecutionStatus(teamName, memberName, "idle", { force: true })
    if (current.status === "busy") {
      await transitionMemberStatus(teamName, memberName, "ready", { force: true })
    }
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
      if (member.status !== "busy") continue
      if (TERMINAL_EXECUTION_STATES.has(member.execution_status ?? "idle")) continue
      log.info("cancelling member", { teamName, memberName: member.name, sessionID: member.sessionID })
      await transitionExecutionStatus(teamName, member.name, "cancel_requested")
      SessionPrompt.cancel(member.sessionID)
      await transitionExecutionStatus(teamName, member.name, "cancelling")
      count++
    }
    return count
  }

  /**
   * Mark teammates that were busy when the server died as cancelled
   * and inject a notification into the lead session.
   * Called once during InstanceBootstrap.
   */
  export async function recover(): Promise<{ interrupted: number }> {
    const teams = await list()
    let count = 0

    for (const team of teams) {
      const active = team.members.filter((m) => m.status === "busy")
      if (active.length === 0) continue

      log.info("marking interrupted teammates", { teamName: team.name, count: active.length })

      const names: string[] = []
      for (const member of active) {
        await transitionExecutionStatus(team.name, member.name, "cancelled", { force: true })
        await transitionExecutionStatus(team.name, member.name, "idle", { force: true })
        await transitionMemberStatus(team.name, member.name, "ready", { force: true })
        names.push(member.name)
        count++
      }

      // Recover undelivered inbox messages for interrupted members and the lead
      try {
        const { TeamMessaging } = await import("./messaging")
        for (const member of active) {
          await TeamMessaging.recoverInbox(team.name, member.name, member.sessionID)
        }
        if (team.leadSessionID) {
          await TeamMessaging.recoverInbox(team.name, "lead", team.leadSessionID)
        }
      } catch (err: unknown) {
        log.warn("inbox recovery failed", {
          teamName: team.name,
          error: err instanceof Error ? err.message : String(err),
        })
      }

      if (!team.leadSessionID) continue

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

/** Shared task board for team coordination. Tasks have composite PK (team_id, id). */
export namespace TeamTasks {
  async function context(teamName: string) {
    const id = teamID(teamName)
    if (!id) return
    const team = await Team.get(teamName)
    if (!team) return
    const byName = new Map(team.members.map((m) => [m.name, m.sessionID]))
    const bySession = new Map(team.members.map((m) => [m.sessionID, m.name]))
    return { id, byName, bySession }
  }

  async function save(teamName: string, tasks: TeamTask[]) {
    const ctx = await context(teamName)
    if (!ctx) return
    const now = Date.now()
    Database.use((db) => {
      db.delete(TeamTaskTable).where(eq(TeamTaskTable.team_id, ctx.id)).run()
      if (!tasks.length) return
      db.insert(TeamTaskTable)
        .values(
          tasks.map((task) => ({
            id: task.id,
            team_id: ctx.id,
            content: task.content,
            status: task.status,
            priority: task.priority,
            assigned_to: task.assignee ? (ctx.byName.get(task.assignee) ?? null) : null,
            depends_on: task.depends_on ?? [],
            time_created: now,
            time_updated: now,
          })),
        )
        .run()
    })
  }

  /**
   * Read all tasks for a team.
   */
  export async function list(teamName: string): Promise<TeamTask[]> {
    const ctx = await context(teamName)
    if (!ctx) return []
    const rows = Database.use((db) => db.select().from(TeamTaskTable).where(eq(TeamTaskTable.team_id, ctx.id)).all())
    return rows.map((task) => ({
      id: task.id,
      content: task.content,
      status: TeamTaskSchema.shape.status.parse(task.status),
      priority: TeamTaskSchema.shape.priority.parse(task.priority),
      assignee: task.assigned_to ? ctx.bySession.get(task.assigned_to) : undefined,
      depends_on: task.depends_on ?? undefined,
    }))
  }

  /**
   * Write the full task list for a team (replaces).
   */
  export async function update(teamName: string, tasks: TeamTask[]): Promise<void> {
    const resolved = resolveDependencies(tasks)
    await save(teamName, resolved)
    Team.touch(teamName)
    await Bus.publish(TeamEvent.TaskUpdated, { teamName, tasks: resolved })
  }

  /**
   * Add tasks to the team's task list.
   */
  export async function add(teamName: string, newTasks: TeamTask[]): Promise<void> {
    const existing = await list(teamName)
    const resolved = resolveDependencies([...existing, ...newTasks])
    await save(teamName, resolved)
    Team.touch(teamName)
    await Bus.publish(TeamEvent.TaskUpdated, { teamName, tasks: resolved })
  }

  /**
   * Atomically claim a task. Returns true if claimed, false if already taken.
   */
  export async function claim(teamName: string, taskId: string, memberName: string): Promise<boolean> {
    const ctx = await context(teamName)
    if (!ctx) return false
    const task = (await list(teamName)).find((t) => t.id === taskId)
    if (!task) return false
    if (task.status !== "pending" || task.assignee) return false
    if (task.depends_on?.length) {
      const tasks = await list(teamName)
      const unresolved = task.depends_on.some((depId) => {
        const dep = tasks.find((t) => t.id === depId)
        return !dep || (dep.status !== "completed" && dep.status !== "cancelled")
      })
      if (unresolved) return false
    }
    const memberSessionID = ctx.byName.get(memberName)
    if (!memberSessionID) return false
    const claimed = Database.use((db) =>
      db
        .update(TeamTaskTable)
        .set({ status: "in_progress", assigned_to: memberSessionID, time_updated: Date.now() })
        .where(
          and(
            eq(TeamTaskTable.id, taskId),
            eq(TeamTaskTable.team_id, ctx.id),
            eq(TeamTaskTable.status, "pending"),
            isNull(TeamTaskTable.assigned_to),
          ),
        )
        .returning({ id: TeamTaskTable.id })
        .get(),
    )
    if (claimed) {
      Team.touch(teamName)
      await Bus.publish(TeamEvent.TaskClaimed, { teamName, taskId, memberName })
    }
    return !!claimed
  }

  /**
   * Mark a task as completed.
   */
  export async function complete(teamName: string, taskId: string): Promise<void> {
    const current = await list(teamName)
    if (!current.length) return
    const updated = current.map((task) => (task.id === taskId ? { ...task, status: "completed" as const } : task))
    const tasks = resolveDependencies(updated)
    const completed = tasks.find((t) => t.id === taskId)
    await save(teamName, tasks)
    Team.touch(teamName)
    await Bus.publish(TeamEvent.TaskUpdated, { teamName, tasks })
    if (!completed) return
    await Bus.publish(TeamEvent.TaskCompleted, { teamName, task: completed })
  }

  function resolveDependencies(tasks: TeamTask[]): TeamTask[] {
    const validIds = new Set(tasks.map((t) => t.id))

    return tasks.map((task) => {
      if (task.depends_on) {
        task = { ...task, depends_on: task.depends_on.filter((id) => validIds.has(id) && id !== task.id) }
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
