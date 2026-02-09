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
 * Tests for Team.recover() — marking active teammates as "interrupted"
 * after a server restart so the user can explicitly resume them.
 */
describe("Team recovery after restart", () => {
  test("marks active members as interrupted", async () => {
    const dir = await fs.mkdtemp(path.join(import.meta.dir, ".tmp-recover-"))

    try {
      // "First boot" — create team with active members
      await Instance.provide({
        directory: dir,
        init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
        fn: async () => {
          await Team.create({
            name: "recover-test",
            leadSessionID: "ses_lead",
          })
          await Team.addMember("recover-test", {
            name: "worker-1",
            sessionID: "ses_w1",
            agent: "general",
            status: "active",
            prompt: "work on stuff",
            planApproval: "none",
          })
          await Team.addMember("recover-test", {
            name: "worker-2",
            sessionID: "ses_w2",
            agent: "explore",
            status: "active",
            prompt: "research things",
            planApproval: "none",
          })
        },
      })

      // "Second boot" — recover should mark both as interrupted
      await Instance.provide({
        directory: dir,
        init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
        fn: async () => {
          const result = await Team.recover()
          expect(result.interrupted).toBe(2)

          const team = await Team.get("recover-test")
          expect(team).toBeDefined()
          expect(team!.members[0].status).toBe("interrupted")
          expect(team!.members[1].status).toBe("interrupted")
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
          await Team.create({
            name: "recover-skip",
            leadSessionID: "ses_lead_skip",
          })
          await Team.addMember("recover-skip", {
            name: "idle-worker",
            sessionID: "ses_idle",
            agent: "general",
            status: "idle",
            prompt: "done",
            planApproval: "none",
          })
          await Team.addMember("recover-skip", {
            name: "shutdown-worker",
            sessionID: "ses_shutdown",
            agent: "general",
            status: "shutdown",
            prompt: "bye",
            planApproval: "none",
          })
        },
      })

      // Fresh context — recover should skip both
      await Instance.provide({
        directory: dir,
        init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
        fn: async () => {
          const result = await Team.recover()
          expect(result.interrupted).toBe(0)

          const team = await Team.get("recover-skip")
          expect(team!.members[0].status).toBe("idle")
          expect(team!.members[1].status).toBe("shutdown")
        },
      })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("marks members as interrupted even when session exists", async () => {
    const dir = await fs.mkdtemp(path.join(import.meta.dir, ".tmp-recover-"))

    try {
      // "First boot" — create team with a real session
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
            status: "active",
            prompt: "do real work",
            planApproval: "none",
          })
        },
      })

      // "Second boot" — even with a valid session, member should be
      // interrupted (not auto-restarted). User must explicitly resume.
      await Instance.provide({
        directory: dir,
        init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
        fn: async () => {
          const result = await Team.recover()
          expect(result.interrupted).toBe(1)

          const team = await Team.get("recover-real")
          expect(team).toBeDefined()
          expect(team!.members[0].status).toBe("interrupted")
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
          await Team.create({
            name: "recover-mix",
            leadSessionID: "ses_lead_mix",
          })
          await Team.addMember("recover-mix", {
            name: "worker-a",
            sessionID: "ses_a",
            agent: "general",
            status: "active",
            prompt: "task a",
            planApproval: "none",
          })
          await Team.addMember("recover-mix", {
            name: "worker-b",
            sessionID: "ses_b",
            agent: "explore",
            status: "idle",
            prompt: "task b",
            planApproval: "none",
          })
          await Team.addMember("recover-mix", {
            name: "worker-c",
            sessionID: "ses_c",
            agent: "general",
            status: "active",
            prompt: "task c",
            planApproval: "none",
          })
        },
      })

      await Instance.provide({
        directory: dir,
        init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
        fn: async () => {
          const result = await Team.recover()
          expect(result.interrupted).toBe(2) // only the two active ones

          const team = await Team.get("recover-mix")
          expect(team!.members.find((m) => m.name === "worker-a")!.status).toBe("interrupted")
          expect(team!.members.find((m) => m.name === "worker-b")!.status).toBe("idle") // untouched
          expect(team!.members.find((m) => m.name === "worker-c")!.status).toBe("interrupted")
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
          await Team.create({ name: "team-alpha", leadSessionID: "ses_alpha" })
          await Team.addMember("team-alpha", {
            name: "alpha-1",
            sessionID: "ses_a1",
            agent: "general",
            status: "active",
            prompt: "work",
            planApproval: "none",
          })

          await Team.create({ name: "team-beta", leadSessionID: "ses_beta" })
          await Team.addMember("team-beta", {
            name: "beta-1",
            sessionID: "ses_b1",
            agent: "explore",
            status: "active",
            prompt: "research",
            planApproval: "none",
          })
          await Team.addMember("team-beta", {
            name: "beta-2",
            sessionID: "ses_b2",
            agent: "general",
            status: "active",
            prompt: "implement",
            planApproval: "none",
          })
        },
      })

      await Instance.provide({
        directory: dir,
        init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
        fn: async () => {
          const result = await Team.recover()
          expect(result.interrupted).toBe(3)

          const alpha = await Team.get("team-alpha")
          expect(alpha!.members[0].status).toBe("interrupted")

          const beta = await Team.get("team-beta")
          expect(beta!.members[0].status).toBe("interrupted")
          expect(beta!.members[1].status).toBe("interrupted")
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
          await Team.create({ name: "idem-test", leadSessionID: "ses_idem" })
          await Team.addMember("idem-test", {
            name: "worker",
            sessionID: "ses_w",
            agent: "general",
            status: "active",
            prompt: "work",
            planApproval: "none",
          })
        },
      })

      // First recovery
      await Instance.provide({
        directory: dir,
        init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
        fn: async () => {
          const r1 = await Team.recover()
          expect(r1.interrupted).toBe(1)

          // Second recovery in same context — already interrupted, skip
          const r2 = await Team.recover()
          expect(r2.interrupted).toBe(0)
        },
      })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
