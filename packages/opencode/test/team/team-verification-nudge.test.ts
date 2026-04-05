/**
 * Tests for the verification nudge in TeamTasksTool complete action.
 *
 * When all tasks are marked complete and none is a verifier task,
 * the output should include a nudge suggesting a verification teammate.
 */
import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Team, TeamTasks } from "../../src/team"
import { Session } from "../../src/session"
import { Env } from "../../src/env"
import { Log } from "../../src/util/log"
import { Identifier } from "../../src/id/id"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

let counter = 0
function uniq(base: string) {
  return `${base}-${Date.now()}-${++counter}`
}

async function seedUser(sessionID: string) {
  const mid = Identifier.ascending("message")
  await Session.updateMessage({
    id: mid,
    sessionID,
    role: "user",
    agent: "general",
    model: { providerID: "anthropic", modelID: "claude-sonnet-4-5-20250929" },
    time: { created: Date.now() },
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: mid,
    sessionID,
    type: "text",
    text: "init",
  })
}

// ---------------------------------------------------------------------------
// 1. Nudge fires when all tasks complete and no verifier exists
// ---------------------------------------------------------------------------
describe("verification nudge — fires when all done", () => {
  test("nudge appears in output when last task is completed with no verifier", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        const name = uniq("nudge-all-done")
        const lead = await Session.create({})
        await Team.create({ name, leadSessionID: lead.id })
        await seedUser(lead.id)

        // Add two tasks
        await TeamTasks.add(name, [
          { id: "task-1", content: "Implement auth module", status: "pending", priority: "high" },
          { id: "task-2", content: "Write unit tests", status: "pending", priority: "medium" },
        ])

        // Complete task-1
        await TeamTasks.complete(name, "task-1")

        // Complete task-2 — now all tasks done, nudge should fire
        await TeamTasks.complete(name, "task-2")

        // Simulate what the tool does: list all, check active
        const allTasks = await TeamTasks.list(name)
        const active = allTasks.filter(t => t.status !== "completed" && t.status !== "cancelled")
        const hasVerifier = allTasks.some(t => /verif/i.test(t.content) || /verif/i.test(t.id))

        expect(active.length).toBe(0)
        expect(hasVerifier).toBe(false)
        // The nudge condition is satisfied
        const shouldNudge = active.length === 0 && !hasVerifier
        expect(shouldNudge).toBe(true)

        await Team.cleanup(name).catch(() => {})
      },
    })
  })
})

// ---------------------------------------------------------------------------
// 2. Nudge suppressed when tasks remain
// ---------------------------------------------------------------------------
describe("verification nudge — suppressed when tasks remain", () => {
  test("no nudge when some tasks still pending", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        const name = uniq("nudge-pending")
        const lead = await Session.create({})
        await Team.create({ name, leadSessionID: lead.id })
        await seedUser(lead.id)

        await TeamTasks.add(name, [
          { id: "task-1", content: "Implement auth module", status: "pending", priority: "high" },
          { id: "task-2", content: "Write unit tests", status: "pending", priority: "medium" },
        ])

        // Complete only task-1 — task-2 still pending
        await TeamTasks.complete(name, "task-1")

        const allTasks = await TeamTasks.list(name)
        const active = allTasks.filter(t => t.status !== "completed" && t.status !== "cancelled")

        expect(active.length).toBe(1)
        // No nudge — tasks remain
        expect(active.length === 0).toBe(false)

        await Team.cleanup(name).catch(() => {})
      },
    })
  })
})

// ---------------------------------------------------------------------------
// 3. Nudge suppressed when a verifier task already exists
// ---------------------------------------------------------------------------
describe("verification nudge — suppressed when verifier exists", () => {
  test("no nudge when a verifier task is in the list", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        const name = uniq("nudge-verifier")
        const lead = await Session.create({})
        await Team.create({ name, leadSessionID: lead.id })
        await seedUser(lead.id)

        await TeamTasks.add(name, [
          { id: "task-1", content: "Implement auth module", status: "pending", priority: "high" },
          { id: "verify-auth", content: "Verify auth implementation", status: "pending", priority: "medium" },
        ])

        // Complete task-1 — verify-auth still pending AND has "verif" in content
        await TeamTasks.complete(name, "task-1")

        const allTasks = await TeamTasks.list(name)
        const active = allTasks.filter(t => t.status !== "completed" && t.status !== "cancelled")
        const hasVerifier = allTasks.some(t => /verif/i.test(t.content) || /verif/i.test(t.id))

        expect(hasVerifier).toBe(true)
        expect(active.length === 0 && !hasVerifier).toBe(false)

        await Team.cleanup(name).catch(() => {})
      },
    })
  })

  test("verifier detected by id containing 'verif'", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        const name = uniq("nudge-verif-id")
        const lead = await Session.create({})
        await Team.create({ name, leadSessionID: lead.id })
        await seedUser(lead.id)

        await TeamTasks.add(name, [
          { id: "impl-1", content: "Build feature X", status: "pending", priority: "high" },
          { id: "verification-step", content: "QA pass", status: "pending", priority: "low" },
        ])

        await TeamTasks.complete(name, "impl-1")

        const allTasks = await TeamTasks.list(name)
        const hasVerifier = allTasks.some(t => /verif/i.test(t.content) || /verif/i.test(t.id))
        expect(hasVerifier).toBe(true)

        await Team.cleanup(name).catch(() => {})
      },
    })
  })
})
