import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Instance } from "../../src/project/instance"
import { Team } from "../../src/team"
import { Session } from "../../src/session"
import { Env } from "../../src/env"
import { Log } from "../../src/util/log"

Log.init({ print: false })

/**
 * Tests for Team.recover() — marking active teammates as "ready"
 * after a server restart so the user can explicitly resume them.
 *
 * Note: Since teams are now stored via the global Storage namespace (keyed by
 * project.id), team data persists across Instance.provide() calls even with
 * different directories — which is exactly what we want for recovery tests.
 * Each test must clean up its teams afterward to avoid polluting other tests.
 */
describe("Team recovery after restart", () => {
  test("marks active members as interrupted", async () => {
    const dir = await fs.mkdtemp(path.join(import.meta.dir, ".tmp-recover-"))

    try {
      await Instance.provide({
        directory: dir,
        init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
        fn: async () => {
          const lead = await Session.create({})
          const w1 = await Session.create({ parentID: lead.id })
          const w2 = await Session.create({ parentID: lead.id })
          await Team.create({
            name: "recover-test",
            leadSessionID: lead.id,
          })
          await Team.addMember("recover-test", {
            name: "worker-1",
            sessionID: w1.id,
            agent: "general",
            status: "busy",
            prompt: "work on stuff",
            planApproval: "none",
          })
          await Team.addMember("recover-test", {
            name: "worker-2",
            sessionID: w2.id,
            agent: "explore",
            status: "busy",
            prompt: "research things",
            planApproval: "none",
          })

          const result = await Team.recover()
          expect(result.interrupted).toBe(2)

          const team = await Team.get("recover-test")
          expect(team).toBeDefined()
          expect(team!.members[0].status).toBe("ready")
          expect(team!.members[1].status).toBe("ready")

          // Cleanup: mark all as shutdown so cleanup succeeds
          await Team.setMemberStatus("recover-test", "worker-1", "shutdown")
          await Team.setMemberStatus("recover-test", "worker-2", "shutdown")
          await Team.cleanup("recover-test")
        },
      })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("skips members with non-active status", async () => {
    const dir = await fs.mkdtemp(path.join(import.meta.dir, ".tmp-recover-"))

    try {
      await Instance.provide({
        directory: dir,
        init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
        fn: async () => {
          const lead = await Session.create({})
          const w1 = await Session.create({ parentID: lead.id })
          const w2 = await Session.create({ parentID: lead.id })
          await Team.create({
            name: "recover-skip",
            leadSessionID: lead.id,
          })
          await Team.addMember("recover-skip", {
            name: "idle-worker",
            sessionID: w1.id,
            agent: "general",
            status: "ready",
            prompt: "done",
            planApproval: "none",
          })
          await Team.addMember("recover-skip", {
            name: "shutdown-worker",
            sessionID: w2.id,
            agent: "general",
            status: "shutdown",
            prompt: "bye",
            planApproval: "none",
          })

          const result = await Team.recover()
          expect(result.interrupted).toBe(0)

          const team = await Team.get("recover-skip")
          expect(team!.members[0].status).toBe("ready")
          expect(team!.members[1].status).toBe("shutdown")

          // Cleanup
          await Team.setMemberStatus("recover-skip", "idle-worker", "shutdown")
          await Team.cleanup("recover-skip")
        },
      })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("marks members as interrupted even when session exists", async () => {
    const dir = await fs.mkdtemp(path.join(import.meta.dir, ".tmp-recover-"))

    try {
      await Instance.provide({
        directory: dir,
        init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
        fn: async () => {
          const leadSession = await Session.create({})
          const memberSession = await Session.create({ parentID: leadSession.id })

          await Team.create({
            name: "recover-real",
            leadSessionID: leadSession.id,
          })
          await Team.addMember("recover-real", {
            name: "real-worker",
            sessionID: memberSession.id,
            agent: "general",
            status: "busy",
            prompt: "do real work",
            planApproval: "none",
          })

          const result = await Team.recover()
          expect(result.interrupted).toBe(1)

          const team = await Team.get("recover-real")
          expect(team).toBeDefined()
          expect(team!.members[0].status).toBe("ready")

          // Cleanup
          await Team.setMemberStatus("recover-real", "real-worker", "shutdown")
          await Team.cleanup("recover-real")
        },
      })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("handles mix of active and non-active members", async () => {
    const dir = await fs.mkdtemp(path.join(import.meta.dir, ".tmp-recover-"))

    try {
      await Instance.provide({
        directory: dir,
        init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
        fn: async () => {
          const lead = await Session.create({})
          const a = await Session.create({ parentID: lead.id })
          const b = await Session.create({ parentID: lead.id })
          const c = await Session.create({ parentID: lead.id })
          await Team.create({
            name: "recover-mix",
            leadSessionID: lead.id,
          })
          await Team.addMember("recover-mix", {
            name: "worker-a",
            sessionID: a.id,
            agent: "general",
            status: "busy",
            prompt: "task a",
            planApproval: "none",
          })
          await Team.addMember("recover-mix", {
            name: "worker-b",
            sessionID: b.id,
            agent: "explore",
            status: "ready",
            prompt: "task b",
            planApproval: "none",
          })
          await Team.addMember("recover-mix", {
            name: "worker-c",
            sessionID: c.id,
            agent: "general",
            status: "busy",
            prompt: "task c",
            planApproval: "none",
          })

          const result = await Team.recover()
          expect(result.interrupted).toBe(2)

          const team = await Team.get("recover-mix")
          expect(team!.members.find((m) => m.name === "worker-a")!.status).toBe("ready")
          expect(team!.members.find((m) => m.name === "worker-b")!.status).toBe("ready")
          expect(team!.members.find((m) => m.name === "worker-c")!.status).toBe("ready")

          // Cleanup
          await Team.setMemberStatus("recover-mix", "worker-a", "shutdown")
          await Team.setMemberStatus("recover-mix", "worker-b", "shutdown")
          await Team.setMemberStatus("recover-mix", "worker-c", "shutdown")
          await Team.cleanup("recover-mix")
        },
      })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("returns zero when no teams exist", async () => {
    const dir = await fs.mkdtemp(path.join(import.meta.dir, ".tmp-recover-"))

    try {
      await Instance.provide({
        directory: dir,
        init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
        fn: async () => {
          const result = await Team.recover()
          expect(result.interrupted).toBe(0)
        },
      })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("handles multiple teams", async () => {
    const dir = await fs.mkdtemp(path.join(import.meta.dir, ".tmp-recover-"))

    try {
      await Instance.provide({
        directory: dir,
        init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
        fn: async () => {
          const l1 = await Session.create({})
          const a1 = await Session.create({ parentID: l1.id })
          await Team.create({ name: "team-alpha", leadSessionID: l1.id })
          await Team.addMember("team-alpha", {
            name: "alpha-1",
            sessionID: a1.id,
            agent: "general",
            status: "busy",
            prompt: "work",
            planApproval: "none",
          })

          const l2 = await Session.create({})
          const b1 = await Session.create({ parentID: l2.id })
          const b2 = await Session.create({ parentID: l2.id })
          await Team.create({ name: "team-beta", leadSessionID: l2.id })
          await Team.addMember("team-beta", {
            name: "beta-1",
            sessionID: b1.id,
            agent: "explore",
            status: "busy",
            prompt: "research",
            planApproval: "none",
          })
          await Team.addMember("team-beta", {
            name: "beta-2",
            sessionID: b2.id,
            agent: "general",
            status: "busy",
            prompt: "implement",
            planApproval: "none",
          })

          const result = await Team.recover()
          expect(result.interrupted).toBe(3)

          const alpha = await Team.get("team-alpha")
          expect(alpha!.members[0].status).toBe("ready")

          const beta = await Team.get("team-beta")
          expect(beta!.members[0].status).toBe("ready")
          expect(beta!.members[1].status).toBe("ready")

          // Cleanup
          await Team.setMemberStatus("team-alpha", "alpha-1", "shutdown")
          await Team.cleanup("team-alpha")
          await Team.setMemberStatus("team-beta", "beta-1", "shutdown")
          await Team.setMemberStatus("team-beta", "beta-2", "shutdown")
          await Team.cleanup("team-beta")
        },
      })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("recover is idempotent — already interrupted members are skipped", async () => {
    const dir = await fs.mkdtemp(path.join(import.meta.dir, ".tmp-recover-"))

    try {
      await Instance.provide({
        directory: dir,
        init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
        fn: async () => {
          const lead = await Session.create({})
          const worker = await Session.create({ parentID: lead.id })
          await Team.create({ name: "idem-test", leadSessionID: lead.id })
          await Team.addMember("idem-test", {
            name: "worker",
            sessionID: worker.id,
            agent: "general",
            status: "busy",
            prompt: "work",
            planApproval: "none",
          })

          const r1 = await Team.recover()
          expect(r1.interrupted).toBe(1)

          // Already interrupted, skip
          const r2 = await Team.recover()
          expect(r2.interrupted).toBe(0)

          // Cleanup
          await Team.setMemberStatus("idem-test", "worker", "shutdown")
          await Team.cleanup("idem-test")
        },
      })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
