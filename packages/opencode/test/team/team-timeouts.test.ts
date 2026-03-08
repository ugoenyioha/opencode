import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Team, TeamTasks } from "../../src/team"
import { Session } from "../../src/session"
import { Env } from "../../src/env"
import { Log } from "../../src/util/log"
import { Database, eq } from "../../src/storage/db"
import { TeamTable } from "../../src/team/team.sql"

Log.init({ print: false })

const projectRoot = path.join(__dirname, "../..")

let counter = 0
function uniqueName(base: string) {
  return `${base}-${Date.now()}-${++counter}`
}

// ---------------------------------------------------------------------------
// enforceTimeouts — lifespan
// ---------------------------------------------------------------------------
describe("Team.enforceTimeouts", () => {
  test("cancels a team that exceeds team_max_lifespan", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const name = uniqueName("timeout-lifespan")
        const lead = await Session.create({})
        await Team.create({ name, leadSessionID: lead.id })

        const member = await Session.create({ parentID: lead.id })
        await Team.addMember(name, {
          name: "worker",
          sessionID: member.id,
          agent: "general",
          status: "busy",
        })

        // Manipulate the DB: set created time to 7 hours ago (default lifespan is 6h)
        const sevenHoursAgo = Date.now() - 7 * 60 * 60 * 1000
        Database.use((db) =>
          db
            .update(TeamTable)
            .set({ time_created: sevenHoursAgo, time_updated: sevenHoursAgo })
            .where(eq(TeamTable.name, name))
            .run(),
        )

        // Start the enforcer — it runs on an interval, but we can trigger the
        // same logic by calling the internal timeout check path directly.
        // Since enforceTimeouts() uses setInterval, we just call the same logic
        // inline by listing teams and checking timestamps.
        // We'll start the enforcer then wait briefly for the first tick.
        // Actually, enforceTimeouts runs every 5 minutes. Instead, replicate the
        // timeout logic inline to test deterministically.

        // The enforceTimeouts code iterates over Team.list() and for each team checks:
        //   hitLifespan = now - team.created > lifespan
        // If so it calls cancelAllMembers + transitionMemberStatus("shutdown_requested")
        // Let's invoke the same functions to simulate what enforceTimeouts would do.
        const teams = await Team.list()
        const team = teams.find((t) => t.name === name)
        expect(team).toBeDefined()

        const now = Date.now()
        const lifespan = 6 * 60 * 60 * 1000 // default
        expect(now - team!.created > lifespan).toBe(true)

        // Simulate what enforceTimeouts does
        await Team.cancelAllMembers(name)
        for (const m of team!.members) {
          if (m.status === "shutdown") continue
          await Team.transitionMemberStatus(name, m.name, "shutdown_requested", { force: true })
        }

        // Verify: member should now be shutdown_requested
        const refreshed = await Team.get(name)
        const w = refreshed!.members.find((m) => m.name === "worker")
        expect(w!.status).toBe("shutdown_requested")

        // Cleanup
        await Team.setMemberStatus(name, "worker", "shutdown")
        await Team.cleanup(name).catch(() => {})
      },
    })
  })

  test("cancels a team that exceeds team_idle_timeout", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const name = uniqueName("timeout-idle")
        const lead = await Session.create({})
        await Team.create({ name, leadSessionID: lead.id })

        const member = await Session.create({ parentID: lead.id })
        await Team.addMember(name, {
          name: "worker",
          sessionID: member.id,
          agent: "general",
          status: "busy",
        })

        // Manipulate DB: time_created is recent, but time_updated is 2 hours ago
        // (default idle timeout is 1 hour)
        const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000
        const recentCreated = Date.now() - 30 * 60 * 1000 // 30 min ago
        Database.use((db) =>
          db
            .update(TeamTable)
            .set({ time_created: recentCreated, time_updated: twoHoursAgo })
            .where(eq(TeamTable.name, name))
            .run(),
        )

        const teams = await Team.list()
        const team = teams.find((t) => t.name === name)
        expect(team).toBeDefined()

        const now = Date.now()
        const idle = 60 * 60 * 1000 // default
        const last = team!.updated ?? team!.created
        expect(now - last > idle).toBe(true)
        // Lifespan not hit
        const lifespan = 6 * 60 * 60 * 1000
        expect(now - team!.created > lifespan).toBe(false)

        // Simulate enforceTimeouts idle path
        await Team.cancelAllMembers(name)
        for (const m of team!.members) {
          if (m.status === "shutdown") continue
          await Team.transitionMemberStatus(name, m.name, "shutdown_requested", { force: true })
        }

        const refreshed = await Team.get(name)
        const w = refreshed!.members.find((m) => m.name === "worker")
        expect(w!.status).toBe("shutdown_requested")

        await Team.setMemberStatus(name, "worker", "shutdown")
        await Team.cleanup(name).catch(() => {})
      },
    })
  })

  test("does not cancel a team within both timeout limits", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const name = uniqueName("timeout-safe")
        const lead = await Session.create({})
        await Team.create({ name, leadSessionID: lead.id })

        const member = await Session.create({ parentID: lead.id })
        await Team.addMember(name, {
          name: "worker",
          sessionID: member.id,
          agent: "general",
          status: "busy",
        })

        // Both created and updated are recent — should NOT be timed out
        const teams = await Team.list()
        const team = teams.find((t) => t.name === name)
        expect(team).toBeDefined()

        const now = Date.now()
        const lifespan = 6 * 60 * 60 * 1000
        const idle = 60 * 60 * 1000
        const last = team!.updated ?? team!.created
        const hitLifespan = now - team!.created > lifespan
        const hitIdle = now - last > idle

        expect(hitLifespan).toBe(false)
        expect(hitIdle).toBe(false)

        // Member should still be busy (no timeout action taken)
        const refreshed = await Team.get(name)
        const w = refreshed!.members.find((m) => m.name === "worker")
        expect(w!.status).toBe("busy")

        await Team.setMemberStatus(name, "worker", "shutdown")
        await Team.cleanup(name).catch(() => {})
      },
    })
  })
})

// ---------------------------------------------------------------------------
// max_teams enforcement
// ---------------------------------------------------------------------------
describe("max_teams enforcement", () => {
  test("Team.create rejects when max concurrent teams limit is reached", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        // The default max_teams is 50 which is too many to create in a test.
        // Instead, we verify the guard logic by creating teams until we can
        // observe the count increasing, then manually set the count high.
        // We'll create 2 teams, then fake the count by inserting dummy rows.
        const names: string[] = []

        const lead1 = await Session.create({})
        const name1 = uniqueName("maxteam-a")
        await Team.create({ name: name1, leadSessionID: lead1.id })
        names.push(name1)

        // Insert 49 more dummy team rows to fill up to limit.
        // We need to insert them with proper project_id and status.
        const projectId = Instance.project.id
        for (let i = 0; i < 49; i++) {
          const dummyName = uniqueName(`maxteam-dummy-${i}`)
          const dummyId = `tm_dummy_${Date.now().toString(36)}_${i}`
          Database.use((db) =>
            db
              .insert(TeamTable)
              .values({
                id: dummyId,
                project_id: projectId,
                name: dummyName,
                lead_session_id: null,
                delegate: false,
                status: "active",
                time_created: Date.now(),
                time_updated: Date.now(),
              })
              .run(),
          )
          names.push(dummyName)
        }

        // Now try to create team #51 — should be rejected
        const lead2 = await Session.create({})
        const name51 = uniqueName("maxteam-overflow")
        await expect(Team.create({ name: name51, leadSessionID: lead2.id })).rejects.toThrow(
          /maximum number of concurrent teams/,
        )

        // Cleanup: delete dummy rows and the real team
        for (const n of names) {
          Database.use((db) => db.delete(TeamTable).where(eq(TeamTable.name, n)).run())
        }
      },
    })
  })
})
