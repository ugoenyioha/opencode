export function shouldHydrateTeamEntry(
  entry:
    | {
        teamName?: string
        role?: "lead" | "member"
        members?: unknown[]
        tasks?: unknown[]
      }
    | undefined,
) {
  if (!entry) return true
  if (!entry.teamName) return true
  if (!Array.isArray(entry.tasks)) return true
  if (entry.role === "member" && (!Array.isArray(entry.members) || entry.members.length === 0)) return true
  return false
}

export function mergeCompletedTask<T extends { id: string }>(tasks: T[] | undefined, task: T) {
  const list = tasks ?? []
  const idx = list.findIndex((t) => t.id === task.id)
  if (idx >= 0) {
    const next = [...list]
    next[idx] = task
    return next
  }
  return [...list, task]
}

export function applyTeammateIdle<T extends { name: string; status?: string; execution_status?: string }>(
  members: T[] | undefined,
  memberName: string,
) {
  const list = members ?? []
  const idx = list.findIndex((m) => m.name === memberName)
  if (idx < 0) return list
  const next = [...list]
  const current = next[idx]
  next[idx] = {
    ...current,
    execution_status: "idle",
    status: current.status === "busy" ? "ready" : current.status,
  }
  return next
}

export function shouldScheduleTeamRefresh(type: string) {
  if (type === "team.message") return false
  if (type === "team.broadcast") return false
  if (type === "team.message.read") return false
  if (type === "team.cleaned") return false
  return true
}

type TeamMember = {
  name: string
  sessionID: string
  agent: string
  status: string
  execution_status?: string
  model?: string
  planApproval?: string
}

type TeamTask = {
  id: string
  content: string
  status: string
  priority: string
  assignee?: string
  depends_on?: string[]
}

type TeamEntry = {
  teamName: string
  role: "lead" | "member"
  memberName?: string
  delegate?: boolean
  members: TeamMember[]
  tasks: TeamTask[]
}

type TeamSnapshot = {
  team: {
    name: string
    leadSessionID: string
    delegate?: boolean
    members: TeamMember[]
  }
  role: "lead" | "member"
  memberName?: string
  tasks: TeamTask[]
}

export function applyTeamSnapshot(team: Record<string, TeamEntry>, sessionID: string, data: TeamSnapshot) {
  const next = { ...team }
  next[sessionID] = {
    teamName: data.team.name,
    role: data.role,
    memberName: data.memberName,
    delegate: data.team.delegate,
    members: data.team.members ?? [],
    tasks: data.tasks ?? [],
  }

  if (!next[data.team.leadSessionID]) {
    next[data.team.leadSessionID] = {
      teamName: data.team.name,
      role: "lead",
      delegate: data.team.delegate,
      members: data.team.members ?? [],
      tasks: data.tasks ?? [],
    }
  }

  for (const member of data.team.members ?? []) {
    if (next[member.sessionID]) continue
    next[member.sessionID] = {
      teamName: data.team.name,
      role: "member",
      memberName: member.name,
      delegate: data.team.delegate,
      members: data.team.members ?? [],
      tasks: data.tasks ?? [],
    }
  }

  return {
    team: next,
    todoSessionIDs: [data.team.leadSessionID, ...(data.team.members ?? []).map((m) => m.sessionID)],
  }
}
