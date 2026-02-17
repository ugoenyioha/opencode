import { describe, expect, test } from "bun:test"
import {
  applyTeamSnapshot,
  applyTeammateIdle,
  mergeCompletedTask,
  shouldHydrateTeamEntry,
  shouldScheduleTeamRefresh,
} from "../../../src/cli/cmd/tui/context/sync-team"

describe("tui sync team helpers", () => {
  test("hydrates when team entry is missing", () => {
    expect(shouldHydrateTeamEntry(undefined)).toBe(true)
  })

  test("hydrates member placeholder with empty members array", () => {
    expect(
      shouldHydrateTeamEntry({
        teamName: "alpha",
        role: "member",
        members: [],
        tasks: [],
      }),
    ).toBe(true)
  })

  test("does not hydrate complete member entry", () => {
    expect(
      shouldHydrateTeamEntry({
        teamName: "alpha",
        role: "member",
        members: [{ name: "a" }],
        tasks: [],
      }),
    ).toBe(false)
  })

  test("team.task.completed merges into task list when missing", () => {
    const tasks = mergeCompletedTask([{ id: "1", content: "a", status: "pending" }], {
      id: "2",
      content: "b",
      status: "completed",
    })
    expect(tasks).toHaveLength(2)
    expect(tasks.find((x) => x.id === "2")?.status).toBe("completed")
  })

  test("team.task.completed replaces existing task by id", () => {
    const tasks = mergeCompletedTask([{ id: "1", content: "a", status: "in_progress" }], {
      id: "1",
      content: "a",
      status: "completed",
    })
    expect(tasks).toHaveLength(1)
    expect(tasks[0].status).toBe("completed")
  })

  test("team.teammate.idle sets execution_status idle and busy to ready", () => {
    const members = applyTeammateIdle(
      [
        { name: "agent-a", status: "busy", execution_status: "running" },
        { name: "agent-b", status: "ready", execution_status: "idle" },
      ],
      "agent-a",
    )
    expect(members[0].execution_status).toBe("idle")
    expect(members[0].status).toBe("ready")
  })

  test("does not schedule refresh for noisy team message events", () => {
    expect(shouldScheduleTeamRefresh("team.message")).toBe(false)
    expect(shouldScheduleTeamRefresh("team.broadcast")).toBe(false)
    expect(shouldScheduleTeamRefresh("team.message.read")).toBe(false)
  })

  test("schedules refresh for state-changing team events", () => {
    expect(shouldScheduleTeamRefresh("team.task.completed")).toBe(true)
    expect(shouldScheduleTeamRefresh("team.member.status")).toBe(true)
  })

  test("snapshot refresh upgrades placeholder member entry with full team state", () => {
    const current = {
      "session-member": {
        teamName: "alpha",
        role: "member" as const,
        memberName: "worker-a",
        members: [],
        tasks: [],
      },
    }

    const snapshot = {
      team: {
        name: "alpha",
        leadSessionID: "session-lead",
        delegate: false,
        members: [
          { name: "worker-a", sessionID: "session-member", agent: "general", status: "busy" },
          { name: "worker-b", sessionID: "session-b", agent: "general", status: "ready" },
        ],
      },
      role: "member" as const,
      memberName: "worker-a",
      tasks: [{ id: "t1", content: "review", status: "in_progress", priority: "high", assignee: "worker-a" }],
    }

    const result = applyTeamSnapshot(current as any, "session-member", snapshot as any)

    expect(result.team["session-member"].members).toHaveLength(2)
    expect(result.team["session-member"].tasks).toHaveLength(1)
    expect(result.team["session-lead"].role).toBe("lead")
    expect(result.team["session-b"].memberName).toBe("worker-b")
  })

  test("snapshot refresh converges stale task status to completed", () => {
    const current = {
      "session-lead": {
        teamName: "alpha",
        role: "lead" as const,
        members: [{ name: "worker-a", sessionID: "session-member", agent: "general", status: "busy" }],
        tasks: [{ id: "t1", content: "review", status: "in_progress", priority: "high", assignee: "worker-a" }],
      },
    }

    const snapshot = {
      team: {
        name: "alpha",
        leadSessionID: "session-lead",
        members: [{ name: "worker-a", sessionID: "session-member", agent: "general", status: "ready" }],
      },
      role: "lead" as const,
      tasks: [{ id: "t1", content: "review", status: "completed", priority: "high", assignee: "worker-a" }],
    }

    const result = applyTeamSnapshot(current as any, "session-lead", snapshot as any)
    expect(result.team["session-lead"].tasks[0].status).toBe("completed")
  })

  test("snapshot refresh returns todo session ids for lead and teammates", () => {
    const result = applyTeamSnapshot({}, "session-lead", {
      team: {
        name: "alpha",
        leadSessionID: "session-lead",
        members: [
          { name: "worker-a", sessionID: "session-a", agent: "general", status: "ready" },
          { name: "worker-b", sessionID: "session-b", agent: "general", status: "ready" },
        ],
      },
      role: "lead",
      tasks: [],
    } as any)

    expect(new Set(result.todoSessionIDs)).toEqual(new Set(["session-lead", "session-a", "session-b"]))
  })
})
