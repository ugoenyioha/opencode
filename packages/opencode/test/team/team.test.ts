import { describe, expect, test, beforeEach } from "bun:test"
import os from "os"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Team, TeamTasks } from "../../src/team"
import { Session } from "../../src/session"
import { Env } from "../../src/env"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import {
  TeamCreateTool,
  TeamSpawnTool,
  TeamMessageTool,
  TeamBroadcastTool,
  TeamTasksTool,
  TeamClaimTool,
  TeamShutdownTool,
  TeamCleanupTool,
} from "../../src/tool/team"
import { initProjectors } from "../../src/server/projectors"

Log.init({ print: false })

const projectRoot = path.join(__dirname, "../..")

// Isolate config/data/cache/state for this test file so upstream config
// validation changes don't read the user's real ~/.config/opencode.
const xdgRoot = path.join(os.tmpdir(), `opencode-team-core-${process.pid}`)
process.env.XDG_DATA_HOME = path.join(xdgRoot, "data")
process.env.XDG_CACHE_HOME = path.join(xdgRoot, "cache")
process.env.XDG_CONFIG_HOME = path.join(xdgRoot, "config")
process.env.XDG_STATE_HOME = path.join(xdgRoot, "state")
process.env.OPENCODE_TEST_HOME = path.join(xdgRoot, "home")
process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR = path.join(xdgRoot, "managed")

async function testInit() {
  Env.set("ANTHROPIC_API_KEY", "test-key")
  initProjectors()
}

describe("Team", () => {
  test("create and get a team", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: testInit,
      fn: async () => {
        const lead = await Session.create({})
        const team = await Team.create({
          name: "test-team-1",
          leadSessionID: lead.id,
        })

        expect(team.name).toBe("test-team-1")
        expect(team.leadSessionID).toBe(lead.id)
        expect(team.members).toEqual([])
        expect(team.created).toBeGreaterThan(0)

        const fetched = await Team.get("test-team-1")
        expect(fetched).toBeDefined()
        expect(fetched!.name).toBe("test-team-1")

        // Cleanup
        await Team.cleanup("test-team-1")
      },
    })
  })

  test("get returns undefined for non-existent team", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: testInit,
      fn: async () => {
        const team = await Team.get("non-existent")
        expect(team).toBeUndefined()
      },
    })
  })

  test("create throws on duplicate team name", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: testInit,
      fn: async () => {
        const lead1 = await Session.create({})
        const lead2 = await Session.create({})
        await Team.create({ name: "dup-team", leadSessionID: lead1.id })
        await expect(Team.create({ name: "dup-team", leadSessionID: lead2.id })).rejects.toThrow(
          'Team "dup-team" already exists',
        )

        await Team.cleanup("dup-team")
      },
    })
  })

  test("add and remove members", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: testInit,
      fn: async () => {
        const lead = await Session.create({})
        await Team.create({ name: "member-team", leadSessionID: lead.id })

        const researcher = await Session.create({ parentID: lead.id })
        await Team.addMember("member-team", {
          name: "researcher",
          sessionID: researcher.id,
          agent: "explore",
          status: "busy",
        })

        let team = await Team.get("member-team")
        expect(team!.members).toHaveLength(1)
        expect(team!.members[0].name).toBe("researcher")
        expect(team!.members[0].agent).toBe("explore")

        const implementer = await Session.create({ parentID: lead.id })
        await Team.addMember("member-team", {
          name: "implementer",
          sessionID: implementer.id,
          agent: "general",
          status: "busy",
        })

        team = await Team.get("member-team")
        expect(team!.members).toHaveLength(2)

        await Team.removeMember("member-team", "researcher")
        team = await Team.get("member-team")
        expect(team!.members).toHaveLength(1)
        expect(team!.members[0].name).toBe("implementer")

        // Cleanup: set remaining member to shutdown first
        await Team.setMemberStatus("member-team", "implementer", "shutdown")
        await Team.cleanup("member-team")
      },
    })
  })

  test("setMemberStatus updates member", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: testInit,
      fn: async () => {
        const lead = await Session.create({})
        await Team.create({ name: "status-team", leadSessionID: lead.id })
        const worker = await Session.create({ parentID: lead.id })
        await Team.addMember("status-team", {
          name: "worker",
          sessionID: worker.id,
          agent: "general",
          status: "busy",
        })

        await Team.setMemberStatus("status-team", "worker", "ready")
        let team = await Team.get("status-team")
        expect(team!.members[0].status).toBe("ready")

        await Team.setMemberStatus("status-team", "worker", "shutdown")
        team = await Team.get("status-team")
        expect(team!.members[0].status).toBe("shutdown")

        await Team.cleanup("status-team")
      },
    })
  })

  test("cleanup fails if active members exist", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: testInit,
      fn: async () => {
        const lead = await Session.create({})
        await Team.create({ name: "active-team", leadSessionID: lead.id })
        const busyWorker = await Session.create({ parentID: lead.id })
        await Team.addMember("active-team", {
          name: "busy-worker",
          sessionID: busyWorker.id,
          agent: "general",
          status: "busy",
        })

        await expect(Team.cleanup("active-team")).rejects.toThrow("non-shutdown member")

        // Fix: shut down the worker, then clean up
        await Team.setMemberStatus("active-team", "busy-worker", "shutdown")
        await Team.cleanup("active-team")
      },
    })
  })

  test("findBySession finds lead and member roles", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: testInit,
      fn: async () => {
        const lead = await Session.create({})
        await Team.create({ name: "find-team", leadSessionID: lead.id })
        const finder = await Session.create({ parentID: lead.id })
        await Team.addMember("find-team", {
          name: "finder",
          sessionID: finder.id,
          agent: "explore",
          status: "busy",
        })

        const leadResult = await Team.findBySession(lead.id)
        expect(leadResult).toBeDefined()
        expect(leadResult!.role).toBe("lead")

        const memberResult = await Team.findBySession(finder.id)
        expect(memberResult).toBeDefined()
        expect(memberResult!.role).toBe("member")
        expect(memberResult!.memberName).toBe("finder")

        const notFound = await Team.findBySession("ses_unknown")
        expect(notFound).toBeUndefined()

        await Team.setMemberStatus("find-team", "finder", "shutdown")
        await Team.cleanup("find-team")
      },
    })
  })
})

describe("TeamTasks", () => {
  test("add and list tasks", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: testInit,
      fn: async () => {
        const lead = await Session.create({})
        await Team.create({ name: "task-team", leadSessionID: lead.id })

        await TeamTasks.add("task-team", [
          { id: "t1", content: "Research auth module", status: "pending", priority: "high" },
          { id: "t2", content: "Review API endpoints", status: "pending", priority: "medium" },
        ])

        const tasks = await TeamTasks.list("task-team")
        expect(tasks).toHaveLength(2)
        expect(tasks[0].id).toBe("t1")
        expect(tasks[1].id).toBe("t2")

        await Team.cleanup("task-team")
      },
    })
  })

  test("claim task atomically", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: testInit,
      fn: async () => {
        const lead = await Session.create({})
        await Team.create({ name: "claim-team", leadSessionID: lead.id })
        const wA = await Session.create({ parentID: lead.id })
        await Team.addMember("claim-team", { name: "worker-a", sessionID: wA.id, agent: "general", status: "busy" })
        const wB = await Session.create({ parentID: lead.id })
        await Team.addMember("claim-team", { name: "worker-b", sessionID: wB.id, agent: "general", status: "busy" })
        await TeamTasks.add("claim-team", [{ id: "t1", content: "Do work", status: "pending", priority: "high" }])

        const claimed = await TeamTasks.claim("claim-team", "t1", "worker-a")
        expect(claimed).toBe(true)

        // Second claim should fail
        const claimed2 = await TeamTasks.claim("claim-team", "t1", "worker-b")
        expect(claimed2).toBe(false)

        const tasks = await TeamTasks.list("claim-team")
        expect(tasks[0].status).toBe("in_progress")
        expect(tasks[0].assignee).toBe("worker-a")

        await Team.setMemberStatus("claim-team", "worker-a", "shutdown")
        await Team.setMemberStatus("claim-team", "worker-b", "shutdown")
        await Team.cleanup("claim-team")
      },
    })
  })

  test("claim respects dependencies", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: testInit,
      fn: async () => {
        const lead = await Session.create({})
        await Team.create({ name: "dep-team", leadSessionID: lead.id })
        const w = await Session.create({ parentID: lead.id })
        await Team.addMember("dep-team", { name: "worker", sessionID: w.id, agent: "general", status: "busy" })
        await TeamTasks.add("dep-team", [
          { id: "t1", content: "Step 1", status: "pending", priority: "high" },
          { id: "t2", content: "Step 2", status: "pending", priority: "high", depends_on: ["t1"] },
        ])

        // t2 should be blocked and unclaimed
        const claimBlocked = await TeamTasks.claim("dep-team", "t2", "worker")
        expect(claimBlocked).toBe(false)

        // Claim and complete t1
        await TeamTasks.claim("dep-team", "t1", "worker")
        await TeamTasks.complete("dep-team", "t1")

        // Now t2 should be claimable
        const tasks = await TeamTasks.list("dep-team")
        const t2 = tasks.find((t) => t.id === "t2")
        expect(t2!.status).toBe("pending") // auto-unblocked

        const claimUnblocked = await TeamTasks.claim("dep-team", "t2", "worker")
        expect(claimUnblocked).toBe(true)

        await Team.setMemberStatus("dep-team", "worker", "shutdown")
        await Team.cleanup("dep-team")
      },
    })
  })

  test("self-dependency is removed during task resolution", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: testInit,
      fn: async () => {
        const lead = await Session.create({})
        await Team.create({ name: "self-dep-team", leadSessionID: lead.id })
        await TeamTasks.add("self-dep-team", [
          {
            id: "t1",
            content: "Do work",
            status: "pending",
            priority: "high",
            depends_on: ["t1"],
          },
        ])

        const tasks = await TeamTasks.list("self-dep-team")
        expect(tasks[0].depends_on).toHaveLength(0)
        expect(tasks[0].status).toBe("pending")

        await Team.cleanup("self-dep-team")
      },
    })
  })

  test("complete auto-unblocks dependent tasks", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: testInit,
      fn: async () => {
        const lead = await Session.create({})
        await Team.create({ name: "unblock-team", leadSessionID: lead.id })
        await TeamTasks.add("unblock-team", [
          { id: "t1", content: "Foundation", status: "pending", priority: "high" },
          { id: "t2", content: "Depends on t1", status: "pending", priority: "medium", depends_on: ["t1"] },
          { id: "t3", content: "Depends on t1 and t2", status: "pending", priority: "low", depends_on: ["t1", "t2"] },
        ])

        // t2 and t3 should be blocked initially
        let tasks = await TeamTasks.list("unblock-team")
        expect(tasks.find((t) => t.id === "t2")!.status).toBe("blocked")
        expect(tasks.find((t) => t.id === "t3")!.status).toBe("blocked")

        // Complete t1
        await TeamTasks.claim("unblock-team", "t1", "worker")
        await TeamTasks.complete("unblock-team", "t1")

        tasks = await TeamTasks.list("unblock-team")
        expect(tasks.find((t) => t.id === "t2")!.status).toBe("pending") // unblocked
        expect(tasks.find((t) => t.id === "t3")!.status).toBe("blocked") // still blocked (needs t2)

        await Team.cleanup("unblock-team")
      },
    })
  })

  test("update replaces the full task list", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: testInit,
      fn: async () => {
        const lead = await Session.create({})
        await Team.create({ name: "update-team", leadSessionID: lead.id })
        await TeamTasks.add("update-team", [{ id: "old", content: "Old task", status: "pending", priority: "low" }])

        await TeamTasks.update("update-team", [
          { id: "new1", content: "New task 1", status: "pending", priority: "high" },
          { id: "new2", content: "New task 2", status: "in_progress", priority: "medium" },
        ])

        const tasks = await TeamTasks.list("update-team")
        expect(tasks).toHaveLength(2)
        expect(tasks[0].id).toBe("new1")

        await Team.cleanup("update-team")
      },
    })
  })
})

describe("Team auto-cleanup", () => {
  test("auto-cleanup triggers when all members reach shutdown", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: testInit,
      fn: async () => {
        // Enable auto-cleanup subscriber
        const unsub = Team.autoCleanup()

        const lead = await Session.create({})
        await Team.create({ name: "auto-clean-team", leadSessionID: lead.id })
        const workerA = await Session.create({ parentID: lead.id })
        await Team.addMember("auto-clean-team", {
          name: "worker-a",
          sessionID: workerA.id,
          agent: "general",
          status: "busy",
        })
        const workerB = await Session.create({ parentID: lead.id })
        await Team.addMember("auto-clean-team", {
          name: "worker-b",
          sessionID: workerB.id,
          agent: "general",
          status: "busy",
        })

        // Shut down first member — team still has active members
        await Team.setMemberStatus("auto-clean-team", "worker-a", "shutdown")

        // Small delay to let async subscriber process
        await new Promise((r) => setTimeout(r, 50))

        // Team should still exist because worker-b is active
        const stillExists = await Team.get("auto-clean-team")
        expect(stillExists).toBeDefined()

        // Shut down second member — all members now shutdown
        await Team.setMemberStatus("auto-clean-team", "worker-b", "shutdown")

        // Allow async subscriber to process
        await new Promise((r) => setTimeout(r, 100))

        // Team should be auto-cleaned
        const gone = await Team.get("auto-clean-team")
        expect(gone).toBeUndefined()

        unsub()
      },
    })
  })

  test("auto-cleanup does not trigger when some members are still active", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: testInit,
      fn: async () => {
        const unsub = Team.autoCleanup()

        const lead = await Session.create({})
        await Team.create({ name: "no-clean-team", leadSessionID: lead.id })
        const worker1 = await Session.create({ parentID: lead.id })
        await Team.addMember("no-clean-team", {
          name: "worker-1",
          sessionID: worker1.id,
          agent: "general",
          status: "busy",
        })
        const worker2 = await Session.create({ parentID: lead.id })
        await Team.addMember("no-clean-team", {
          name: "worker-2",
          sessionID: worker2.id,
          agent: "general",
          status: "busy",
        })

        // Shut down only one
        await Team.setMemberStatus("no-clean-team", "worker-1", "shutdown")
        await new Promise((r) => setTimeout(r, 100))

        // Team should still exist
        const team = await Team.get("no-clean-team")
        expect(team).toBeDefined()
        expect(team!.members).toHaveLength(2)

        // Manual cleanup
        await Team.setMemberStatus("no-clean-team", "worker-2", "shutdown")
        await new Promise((r) => setTimeout(r, 100))

        unsub()
      },
    })
  })

  test("auto-cleanup does not trigger on idle status changes", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: testInit,
      fn: async () => {
        const unsub = Team.autoCleanup()

        const lead = await Session.create({})
        await Team.create({ name: "idle-team", leadSessionID: lead.id })
        const workerIdle = await Session.create({ parentID: lead.id })
        await Team.addMember("idle-team", {
          name: "worker-idle",
          sessionID: workerIdle.id,
          agent: "general",
          status: "busy",
        })

        // Set to idle — should NOT trigger cleanup
        await Team.setMemberStatus("idle-team", "worker-idle", "ready")
        await new Promise((r) => setTimeout(r, 100))

        const team = await Team.get("idle-team")
        expect(team).toBeDefined()

        // Manual cleanup
        await Team.setMemberStatus("idle-team", "worker-idle", "shutdown")
        await new Promise((r) => setTimeout(r, 100))

        unsub()
      },
    })
  })
})

describe("Team constraints", () => {
  test("one team per lead session", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: testInit,
      fn: async () => {
        const lead = await Session.create({})
        await Team.create({ name: "lead-team-1", leadSessionID: lead.id })

        // Same session cannot lead a second team
        await expect(Team.create({ name: "lead-team-2", leadSessionID: lead.id })).rejects.toThrow(
          "Only one team per session",
        )

        await Team.cleanup("lead-team-1")
      },
    })
  })

  test("teammate session cannot create a team", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: testInit,
      fn: async () => {
        const lead = await Session.create({})
        await Team.create({ name: "parent-team", leadSessionID: lead.id })
        const worker = await Session.create({ parentID: lead.id })
        await Team.addMember("parent-team", {
          name: "worker",
          sessionID: worker.id,
          agent: "general",
          status: "busy",
        })

        // Worker session cannot create a team (no nesting)
        await expect(Team.create({ name: "nested-team", leadSessionID: worker.id })).rejects.toThrow(
          "Teammates cannot create new teams",
        )

        await Team.setMemberStatus("parent-team", "worker", "shutdown")
        await Team.cleanup("parent-team")
      },
    })
  })

  test("different sessions can lead different teams", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: testInit,
      fn: async () => {
        const leadA = await Session.create({})
        const leadB = await Session.create({})
        const team1 = await Team.create({ name: "team-a", leadSessionID: leadA.id })
        const team2 = await Team.create({ name: "team-b", leadSessionID: leadB.id })

        expect(team1.name).toBe("team-a")
        expect(team2.name).toBe("team-b")

        await Team.cleanup("team-a")
        await Team.cleanup("team-b")
      },
    })
  })
})

describe("Team tool definitions", () => {
  test("all team tools can be initialized", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: testInit,
      fn: async () => {
        const tools = [
          TeamCreateTool,
          TeamSpawnTool,
          TeamMessageTool,
          TeamBroadcastTool,
          TeamTasksTool,
          TeamClaimTool,
          TeamShutdownTool,
          TeamCleanupTool,
        ]

        for (const tool of tools) {
          const initialized = await tool.init()
          expect(initialized.description).toBeTruthy()
          expect(initialized.parameters).toBeDefined()
          expect(typeof initialized.execute).toBe("function")
        }
      },
    })
  })

  test("team tools have correct IDs", () => {
    expect(TeamCreateTool.id).toBe("team_create")
    expect(TeamSpawnTool.id).toBe("team_spawn")
    expect(TeamMessageTool.id).toBe("team_message")
    expect(TeamBroadcastTool.id).toBe("team_broadcast")
    expect(TeamTasksTool.id).toBe("team_tasks")
    expect(TeamClaimTool.id).toBe("team_claim")
    expect(TeamShutdownTool.id).toBe("team_shutdown")
    expect(TeamCleanupTool.id).toBe("team_cleanup")
  })

  test("TeamCreateTool rejects teammate sessions", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: testInit,
      fn: async () => {
        // Set up a team with a member
        const lead = await Session.create({})
        await Team.create({ name: "tool-guard-team", leadSessionID: lead.id })
        const worker = await Session.create({ parentID: lead.id })
        await Team.addMember("tool-guard-team", {
          name: "guarded-worker",
          sessionID: worker.id,
          agent: "general",
          status: "busy",
        })

        const tool = await TeamCreateTool.init()
        const result = await tool.execute({ name: "nested-attempt" }, {
          sessionID: worker.id,
          messageID: "msg_1",
          agent: "general",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => {},
          ask: async () => {},
        } as any)

        expect(result.title).toBe("Error")
        expect(result.output).toContain("Teammates cannot create new teams")

        await Team.setMemberStatus("tool-guard-team", "guarded-worker", "shutdown")
        await Team.cleanup("tool-guard-team")
      },
    })
  })

  test("TeamCreateTool rejects session already leading a team", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: testInit,
      fn: async () => {
        const lead = await Session.create({})
        await Team.create({ name: "existing-lead-team", leadSessionID: lead.id })

        const tool = await TeamCreateTool.init()
        const result = await tool.execute({ name: "second-team" }, {
          sessionID: lead.id,
          messageID: "msg_1",
          agent: "general",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => {},
          ask: async () => {},
        } as any)

        expect(result.title).toBe("Error")
        expect(result.output).toContain("already leading team")

        await Team.cleanup("existing-lead-team")
      },
    })
  })

  test("TeamShutdownTool rejects non-lead sessions", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: testInit,
      fn: async () => {
        const lead = await Session.create({})
        await Team.create({ name: "shutdown-guard-team", leadSessionID: lead.id })
        const worker = await Session.create({ parentID: lead.id })
        await Team.addMember("shutdown-guard-team", {
          name: "worker-x",
          sessionID: worker.id,
          agent: "general",
          status: "busy",
        })

        const tool = await TeamShutdownTool.init()

        // Member tries to shutdown another member — should fail
        const result = await tool.execute({ name: "worker-x" }, {
          sessionID: worker.id,
          messageID: "msg_1",
          agent: "general",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => {},
          ask: async () => {},
        } as any)

        expect(result.title).toBe("Error")
        expect(result.output).toContain("Only the team lead")

        await Team.setMemberStatus("shutdown-guard-team", "worker-x", "shutdown")
        await Team.cleanup("shutdown-guard-team")
      },
    })
  })

  test("TeamShutdownTool does not allow unassociated root session to reclaim lead while original lead exists", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: testInit,
      fn: async () => {
        const lead = await Session.create({})
        const outsider = await Session.create({})
        const worker = await Session.create({ parentID: lead.id })

        await Team.create({ name: "shutdown-reclaim-guard", leadSessionID: lead.id })
        await Team.addMember("shutdown-reclaim-guard", {
          name: "worker-x",
          sessionID: worker.id,
          agent: "general",
          status: "ready",
        })

        const tool = await TeamShutdownTool.init()
        const result = await tool.execute({ name: "worker-x" }, {
          sessionID: outsider.id,
          messageID: "msg_1",
          agent: "general",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => {},
          ask: async () => {},
        } as any)

        expect(result.title).toBe("Error")
        expect(result.output).toContain("Only the team lead")

        await Team.setMemberStatus("shutdown-reclaim-guard", "worker-x", "shutdown")
        await Team.cleanup("shutdown-reclaim-guard")
      },
    })
  })

  test("TeamCleanupTool does not allow unassociated root session to cleanup even when members are shutdown", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: testInit,
      fn: async () => {
        const lead = await Session.create({})
        const outsider = await Session.create({})
        const worker = await Session.create({ parentID: lead.id })

        await Team.create({ name: "cleanup-reclaim-guard", leadSessionID: lead.id })
        await Team.addMember("cleanup-reclaim-guard", {
          name: "worker-x",
          sessionID: worker.id,
          agent: "general",
          status: "shutdown",
        })

        const tool = await TeamCleanupTool.init()
        const result = await tool.execute({ name: "cleanup-reclaim-guard" }, {
          sessionID: outsider.id,
          messageID: "msg_1",
          agent: "general",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => {},
          ask: async () => {},
        } as any)

        expect(result.title).toBe("Error")
        expect(result.output).toContain("Only the lead")

        await Team.cleanup("cleanup-reclaim-guard")
      },
    })
  })

  test("TeamShutdownTool allows legitimate lead rebind when original lead session is deleted", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const lead = await Session.create({})
        const replacement = await Session.create({})
        const worker = await Session.create({ parentID: lead.id })

        await Team.create({ name: "shutdown-rebind-allowed", leadSessionID: lead.id })
        await Team.addMember("shutdown-rebind-allowed", {
          name: "worker-x",
          sessionID: worker.id,
          agent: "general",
          status: "shutdown",
        })

        // Delete only the lead session row (not children) so the worker
        // session and team survive. Session.remove() would recursively
        // delete children, destroying the worker member registration.
        const { Database, eq } = await import("../../src/storage/db")
        const { SessionTable } = await import("../../src/session/session.sql")
        Database.use((db) => {
          db.delete(SessionTable).where(eq(SessionTable.id, lead.id)).run()
        })

        const tool = await TeamShutdownTool.init()
        const result = await tool.execute({ name: "worker-x" }, {
          sessionID: replacement.id,
          messageID: "msg_1",
          agent: "general",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => {},
          ask: async () => {},
        } as any)

        expect(result.title).toBe("Already shutdown")

        const team = await Team.get("shutdown-rebind-allowed")
        expect(team?.leadSessionID).toBe(replacement.id)

        await Team.cleanup("shutdown-rebind-allowed")
      },
    })
  })

  test("TeamCleanupTool allows legitimate lead rebind when original lead session is deleted", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const lead = await Session.create({})
        const replacement = await Session.create({})

        await Team.create({ name: "cleanup-rebind-allowed", leadSessionID: lead.id })
        await Session.remove(lead.id)

        const tool = await TeamCleanupTool.init()
        const result = await tool.execute({ name: "cleanup-rebind-allowed" }, {
          sessionID: replacement.id,
          messageID: "msg_1",
          agent: "general",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => {},
          ask: async () => {},
        } as any)

        expect(result.title).toContain("Team cleaned up")
        const team = await Team.get("cleanup-rebind-allowed")
        expect(team).toBeUndefined()
      },
    })
  })

  test("TeamClaimTool rejects session not in a team", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: testInit,
      fn: async () => {
        const tool = await TeamClaimTool.init()
        const result = await tool.execute({ task_id: "t1" }, {
          sessionID: "ses_orphan",
          messageID: "msg_1",
          agent: "general",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => {},
          ask: async () => {},
        } as any)

        expect(result.title).toBe("Error")
        expect(result.output).toContain("not part of any team")
      },
    })
  })

  test("TeamTasksTool lists tasks for team member", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: testInit,
      fn: async () => {
        const lead = await Session.create({})
        await Team.create({ name: "tasks-tool-team", leadSessionID: lead.id })
        await TeamTasks.add("tasks-tool-team", [
          { id: "t1", content: "First task", status: "pending", priority: "high" },
          { id: "t2", content: "Second task", status: "pending", priority: "medium" },
        ])

        const tool = await TeamTasksTool.init()
        const result = await tool.execute({ action: "list" }, {
          sessionID: lead.id,
          messageID: "msg_1",
          agent: "general",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => {},
          ask: async () => {},
        } as any)

        expect(result.title).toBe("Task list")
        expect(result.output).toContain("First task")
        expect(result.output).toContain("Second task")
        expect(result.metadata.count).toBe(2)

        await Team.cleanup("tasks-tool-team")
      },
    })
  })
})
