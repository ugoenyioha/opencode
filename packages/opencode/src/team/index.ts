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
