import path from "path"
import { mkdir, readdir, rm } from "fs/promises"
import { Log } from "../util/log"
import { Lock } from "../util/lock"
import { Bus } from "../bus"
import { Instance } from "../project/instance"
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

function teamsDir(): string {
  return path.join(Instance.directory, ".opencode", "teams")
}

function teamDir(teamName: string): string {
  const resolved = path.resolve(teamsDir(), teamName)
  if (!resolved.startsWith(teamsDir())) {
    throw new Error(`Invalid team name: "${teamName}" — path traversal detected`)
  }
  return resolved
}

function configPath(teamName: string): string {
  return path.join(teamDir(teamName), "config.json")
}

function tasksPath(teamName: string): string {
  return path.join(teamDir(teamName), "tasks.json")
}

async function ensureDir(dir: string) {
  await mkdir(dir, { recursive: true })
}

export namespace Team {
  /**
   * Create a new team. The lead session is the caller's session.
   */
  export async function create(input: { name: string; leadSessionID: string; delegate?: boolean }): Promise<TeamInfo> {
    using _lock = await Lock.write("team-create")
    const existing = await get(input.name)
    if (existing) {
      throw new Error(`Team "${input.name}" already exists`)
    }

    // One team per lead session — prevent a session from leading multiple teams
    const existingLead = await findBySession(input.leadSessionID)
    if (existingLead && existingLead.role === "lead") {
      throw new Error(
        `Session is already leading team "${existingLead.team.name}". Only one team per session is allowed.`,
      )
    }
    // Prevent teammates from creating teams (no nesting)
    if (existingLead && existingLead.role === "member") {
      throw new Error(`This session is a teammate in "${existingLead.team.name}". Teammates cannot create new teams.`)
    }

    const dir = teamDir(input.name)
    await ensureDir(dir)

    const team: TeamInfo = {
      name: input.name,
      leadSessionID: input.leadSessionID,
      members: [],
      created: Date.now(),
      ...(input.delegate ? { delegate: true } : {}),
    }

    await Bun.write(configPath(input.name), JSON.stringify(team, null, 2))
    await Bun.write(tasksPath(input.name), JSON.stringify([], null, 2))

    log.info("team created", { name: input.name, leadSessionID: input.leadSessionID })
    await Bus.publish(TeamEvent.Created, { team })

    return team
  }

  /**
   * Get a team by name. Returns undefined if not found.
   */
  export async function get(teamName: string): Promise<TeamInfo | undefined> {
    try {
      const text = await Bun.file(configPath(teamName)).text()
      return TeamInfoSchema.parse(JSON.parse(text))
    } catch {
      return undefined
    }
  }

  /**
   * List all teams in this project.
   */
  export async function list(): Promise<TeamInfo[]> {
    const dir = teamsDir()
    try {
      const entries = await readdir(dir)
      const results = await Promise.all(entries.map((entry) => get(entry)))
      return results.filter((t): t is TeamInfo => t !== undefined)
    } catch {
      return []
    }
  }

  /**
   * Add a member to a team. Writes config and publishes event.
   */
  export async function addMember(teamName: string, member: TeamMember): Promise<void> {
    using _ = await Lock.write(`team:${teamName}`)
    const team = await get(teamName)
    if (!team) throw new Error(`Team "${teamName}" not found`)

    // Replace existing member with same name, or add new
    const existing = team.members.findIndex((m) => m.name === member.name)
    if (existing >= 0) {
      team.members[existing] = member
    } else {
      team.members.push(member)
    }

    await Bun.write(configPath(teamName), JSON.stringify(team, null, 2))

    log.info("member added", { teamName, member: member.name, agent: member.agent })
    await Bus.publish(TeamEvent.MemberSpawned, { teamName, member })
  }

  /**
   * Update a member's status.
   */
  export async function setMemberStatus(teamName: string, memberName: string, status: MemberStatus): Promise<void> {
    using _ = await Lock.write(`team:${teamName}`)
    const team = await get(teamName)
    if (!team) return

    const member = team.members.find((m) => m.name === memberName)
    if (!member) return

    member.status = status
    await Bun.write(configPath(teamName), JSON.stringify(team, null, 2))

    await Bus.publish(TeamEvent.MemberStatusChanged, { teamName, memberName, status })
  }

  /**
   * Toggle delegate mode on a team.
   */
  export async function setDelegate(teamName: string, delegate: boolean): Promise<void> {
    using _ = await Lock.write(`team:${teamName}`)
    const team = await get(teamName)
    if (!team) return

    team.delegate = delegate
    await Bun.write(configPath(teamName), JSON.stringify(team, null, 2))
  }

  /**
   * Update a member's plan approval status.
   */
  export async function setMemberPlanApproval(
    teamName: string,
    memberName: string,
    planApproval: "none" | "pending" | "approved" | "rejected",
  ): Promise<void> {
    using _ = await Lock.write(`team:${teamName}`)
    const team = await get(teamName)
    if (!team) return

    const member = team.members.find((m) => m.name === memberName)
    if (!member) return

    member.planApproval = planApproval
    await Bun.write(configPath(teamName), JSON.stringify(team, null, 2))
  }

  /**
   * Remove a member from a team.
   */
  export async function removeMember(teamName: string, memberName: string): Promise<void> {
    using _ = await Lock.write(`team:${teamName}`)
    const team = await get(teamName)
    if (!team) return

    team.members = team.members.filter((m) => m.name !== memberName)
    await Bun.write(configPath(teamName), JSON.stringify(team, null, 2))

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
      if (team.leadSessionID === sessionID) {
        return { team, role: "lead" }
      }
      const member = team.members.find((m) => m.sessionID === sessionID)
      if (member) {
        return { team, role: "member", memberName: member.name }
      }
    }
    return undefined
  }

  /**
   * Clean up a team — removes config and task files.
   * Fails if any members are still active.
   * Restores lead session permissions if delegate mode was active.
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

    // Restore lead session permissions if delegate mode was active
    if (team.delegate) {
      try {
        const { Session } = await import("../session")
        await Session.update(team.leadSessionID, (draft) => {
          draft.permission = (draft.permission ?? []).filter(
            (rule) => !((WRITE_TOOLS as readonly string[]).includes(rule.permission) && rule.action === "deny"),
          )
        })
        log.info("restored lead session permissions", { teamName, sessionID: team.leadSessionID })
      } catch (err: unknown) {
        log.warn("failed to restore lead session permissions", {
          teamName,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    await rm(teamDir(teamName), { recursive: true, force: true })

    log.info("team cleaned up", { teamName })
    await Bus.publish(TeamEvent.Cleaned, { teamName })
  }

  /**
   * Mark teammates that were active when the server died as "interrupted"
   * and inject a notification into the lead session so the LLM knows to
   * resume them when the user next sends a message.
   *
   * Called once during InstanceBootstrap.
   */
  export async function recover(): Promise<{ interrupted: number }> {
    const teams = await list()
    let interrupted = 0

    for (const team of teams) {
      const active = team.members.filter((m) => m.status === "active")
      if (active.length === 0) continue

      log.info("marking interrupted teammates", { teamName: team.name, count: active.length })

      const names: string[] = []
      for (const member of active) {
        await setMemberStatus(team.name, member.name, "interrupted")
        names.push(member.name)
        interrupted++
      }

      // Inject a notification into the lead session so the LLM knows
      // teammates were interrupted and can resume them on the next prompt.
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

    if (interrupted > 0) {
      log.info("team recovery complete", { interrupted })
    }

    return { interrupted }
  }
}

export namespace TeamTasks {
  /**
   * Read all tasks for a team.
   */
  export async function list(teamName: string): Promise<TeamTask[]> {
    using _ = await Lock.read(`team-tasks:${teamName}`)
    try {
      const text = await Bun.file(tasksPath(teamName)).text()
      return TeamTaskSchema.array().parse(JSON.parse(text))
    } catch {
      return []
    }
  }

  /**
   * Write the full task list for a team (replaces).
   */
  export async function update(teamName: string, tasks: TeamTask[]): Promise<void> {
    using _ = await Lock.write(`team-tasks:${teamName}`)
    const resolved = resolveDependencies(tasks)
    await Bun.write(tasksPath(teamName), JSON.stringify(resolved, null, 2))
    await Bus.publish(TeamEvent.TaskUpdated, { teamName, tasks: resolved })
  }

  /**
   * Add tasks to the team's task list.
   */
  export async function add(teamName: string, newTasks: TeamTask[]): Promise<void> {
    // Read outside the write lock, then re-read inside
    using _ = await Lock.write(`team-tasks:${teamName}`)
    let existing: TeamTask[]
    try {
      const text = await Bun.file(tasksPath(teamName)).text()
      existing = TeamTaskSchema.array().parse(JSON.parse(text))
    } catch {
      existing = []
    }
    const merged = [...existing, ...newTasks]
    const resolved = resolveDependencies(merged)
    await Bun.write(tasksPath(teamName), JSON.stringify(resolved, null, 2))
    await Bus.publish(TeamEvent.TaskUpdated, { teamName, tasks: resolved })
  }

  /**
   * Atomically claim a task. Returns true if claimed, false if already taken.
   */
  export async function claim(teamName: string, taskId: string, memberName: string): Promise<boolean> {
    using _ = await Lock.write(`team-tasks:${teamName}`)
    let tasks: TeamTask[]
    try {
      const text = await Bun.file(tasksPath(teamName)).text()
      tasks = TeamTaskSchema.array().parse(JSON.parse(text))
    } catch {
      return false
    }

    const task = tasks.find((t) => t.id === taskId)
    if (!task) return false
    if (task.status !== "pending") return false
    if (task.assignee) return false

    // Check deps are resolved (completed or cancelled count as resolved)
    if (task.depends_on?.length) {
      const hasUnresolved = task.depends_on.some((depId) => {
        const dep = tasks.find((t) => t.id === depId)
        return !dep || (dep.status !== "completed" && dep.status !== "cancelled")
      })
      if (hasUnresolved) return false
    }

    task.status = "in_progress"
    task.assignee = memberName
    await Bun.write(tasksPath(teamName), JSON.stringify(tasks, null, 2))

    await Bus.publish(TeamEvent.TaskClaimed, { teamName, taskId, memberName })
    return true
  }

  /**
   * Mark a task as completed.
   */
  export async function complete(teamName: string, taskId: string): Promise<void> {
    using _ = await Lock.write(`team-tasks:${teamName}`)
    let tasks: TeamTask[]
    try {
      const text = await Bun.file(tasksPath(teamName)).text()
      tasks = TeamTaskSchema.array().parse(JSON.parse(text))
    } catch {
      return
    }

    const task = tasks.find((t) => t.id === taskId)
    if (!task) return

    task.status = "completed"

    // Auto-unblock dependent tasks
    const resolved = resolveDependencies(tasks)
    await Bun.write(tasksPath(teamName), JSON.stringify(resolved, null, 2))
    await Bus.publish(TeamEvent.TaskUpdated, { teamName, tasks: resolved })
  }

  /**
   * Apply dependency resolution — same logic as the per-session Todo system.
   */
  function resolveDependencies(tasks: TeamTask[]): TeamTask[] {
    const validIds = new Set(tasks.map((t) => t.id))

    return tasks.map((task) => {
      // Strip refs to non-existent IDs
      if (task.depends_on) {
        task = { ...task, depends_on: task.depends_on.filter((id) => validIds.has(id)) }
      }

      if (!task.depends_on?.length) return task

      const hasUnresolved = task.depends_on.some((depId) => {
        const dep = tasks.find((t) => t.id === depId)
        return !dep || (dep.status !== "completed" && dep.status !== "cancelled")
      })

      if (hasUnresolved && task.status === "pending") {
        return { ...task, status: "blocked" }
      }
      if (!hasUnresolved && task.status === "blocked") {
        return { ...task, status: "pending" }
      }
      return task
    })
  }
}
