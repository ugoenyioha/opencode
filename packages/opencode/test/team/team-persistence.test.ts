import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Instance } from "../../src/project/instance"
import { Team, TeamTasks } from "../../src/team"
import { Env } from "../../src/env"
import { Log } from "../../src/util/log"

Log.init({ print: false })

/**
 * Tests that team state persists to disk and can be read back after
 * a simulated server restart (new Instance.provide context).
 */
describe("Team persistence across restarts", () => {
  test("Team.get reads team created in a previous context", async () => {
    const dir = await fs.mkdtemp(path.join(import.meta.dir, ".tmp-persist-"))

    try {
      // "First boot" — create a team
      await Instance.provide({
        directory: dir,
        init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
        fn: async () => {
          await Team.create({
            name: "persist-test",
            leadSessionID: "ses_lead_abc",
          })
          await Team.addMember("persist-test", {
            name: "worker-1",
            sessionID: "ses_worker_1",
            agent: "general",
            status: "active",
            prompt: "do stuff",
            model: "anthropic/claude-sonnet-4-20250514",
            planApproval: "none",
          })
        },
      })

      // Verify files exist on disk
      const configPath = path.join(dir, ".opencode", "teams", "persist-test", "config.json")
      const configExists = await Bun.file(configPath).exists()
      expect(configExists).toBe(true)

      // "Second boot" — fresh context, read team back
      await Instance.provide({
        directory: dir,
        init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
        fn: async () => {
          const team = await Team.get("persist-test")
          expect(team).toBeDefined()
          expect(team!.name).toBe("persist-test")
          expect(team!.leadSessionID).toBe("ses_lead_abc")
          expect(team!.members).toHaveLength(1)
          expect(team!.members[0].name).toBe("worker-1")
          expect(team!.members[0].status).toBe("active")
          expect(team!.members[0].model).toBe("anthropic/claude-sonnet-4-20250514")
        },
      })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("Team.list finds all teams after restart", async () => {
    const dir = await fs.mkdtemp(path.join(import.meta.dir, ".tmp-persist-"))

    try {
      // Create two teams
      await Instance.provide({
        directory: dir,
        init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
        fn: async () => {
          await Team.create({ name: "alpha", leadSessionID: "ses_alpha" })
          await Team.create({ name: "beta", leadSessionID: "ses_beta" })
        },
      })

      // Fresh context — list should find both
      await Instance.provide({
        directory: dir,
        init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
        fn: async () => {
          const teams = await Team.list()
          const names = teams.map((t) => t.name).sort()
          expect(names).toEqual(["alpha", "beta"])
        },
      })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("Team.findBySession works after restart", async () => {
    const dir = await fs.mkdtemp(path.join(import.meta.dir, ".tmp-persist-"))

    try {
      await Instance.provide({
        directory: dir,
        init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
        fn: async () => {
          await Team.create({ name: "find-test", leadSessionID: "ses_lead_find" })
          await Team.addMember("find-test", {
            name: "searcher",
            sessionID: "ses_member_find",
            agent: "explore",
            status: "active",
            prompt: "search",
            planApproval: "none",
          })
        },
      })

      // Fresh context — findBySession should resolve from disk
      await Instance.provide({
        directory: dir,
        init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
        fn: async () => {
          // Find lead
          const lead = await Team.findBySession("ses_lead_find")
          expect(lead).toBeDefined()
          expect(lead!.role).toBe("lead")
          expect(lead!.team.name).toBe("find-test")

          // Find member
          const member = await Team.findBySession("ses_member_find")
          expect(member).toBeDefined()
          expect(member!.role).toBe("member")
          expect(member!.memberName).toBe("searcher")

          // Non-existent session
          const none = await Team.findBySession("ses_nonexistent")
          expect(none).toBeUndefined()
        },
      })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("TeamTasks persist after restart", async () => {
    const dir = await fs.mkdtemp(path.join(import.meta.dir, ".tmp-persist-"))

    try {
      await Instance.provide({
        directory: dir,
        init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
        fn: async () => {
          await Team.create({ name: "tasks-test", leadSessionID: "ses_tasks" })
          await TeamTasks.add("tasks-test", [
            { id: "t1", content: "Research", status: "completed", priority: "high" },
            { id: "t2", content: "Implement", status: "pending", priority: "high", depends_on: ["t1"] },
            { id: "t3", content: "Test", status: "pending", priority: "medium", depends_on: ["t2"] },
          ])
        },
      })

      // Fresh context — tasks should persist with dependency resolution
      await Instance.provide({
        directory: dir,
        init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
        fn: async () => {
          const tasks = await TeamTasks.list("tasks-test")
          expect(tasks).toHaveLength(3)

          const t1 = tasks.find((t) => t.id === "t1")
          expect(t1!.status).toBe("completed")

          // t2 should be pending (t1 is completed, so unblocked)
          const t2 = tasks.find((t) => t.id === "t2")
          expect(t2!.status).toBe("pending")

          // t3 should be blocked (t2 not completed)
          const t3 = tasks.find((t) => t.id === "t3")
          expect(t3!.status).toBe("blocked")
        },
      })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("Member status updates persist after restart", async () => {
    const dir = await fs.mkdtemp(path.join(import.meta.dir, ".tmp-persist-"))

    try {
      await Instance.provide({
        directory: dir,
        init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
        fn: async () => {
          await Team.create({ name: "status-test", leadSessionID: "ses_st" })
          await Team.addMember("status-test", {
            name: "agent-a",
            sessionID: "ses_a",
            agent: "general",
            status: "active",
            prompt: "work",
            planApproval: "none",
          })
          // Simulate teammate finishing work
          await Team.setMemberStatus("status-test", "agent-a", "idle")
        },
      })

      // Fresh context — status should be "idle" not "active"
      await Instance.provide({
        directory: dir,
        init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
        fn: async () => {
          const team = await Team.get("status-test")
          expect(team!.members[0].status).toBe("idle")
        },
      })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
