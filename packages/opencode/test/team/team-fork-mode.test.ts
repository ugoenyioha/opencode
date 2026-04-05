/**
 * Fork mode tests for the task tool.
 *
 * Fork mode: task() with no subagent_type forks the current session,
 * inheriting full message history. Gated by OPENCODE_FORK_SUBAGENT=1.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { Instance } from "../../src/project/instance"
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

async function seedUser(sessionID: string, text = "init") {
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
    text,
  })
  return mid
}

// ---------------------------------------------------------------------------
// 1. Session.fork copies messages into a new session
// ---------------------------------------------------------------------------
describe("Session.fork — message history inheritance", () => {
  test("forked session has same messages as parent (up to fork point)", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        const parent = await Session.create({})
        await seedUser(parent.id, "message one")
        await seedUser(parent.id, "message two")

        const forked = await Session.fork({ sessionID: parent.id })

        expect(forked.id).not.toBe(parent.id)

        const parentMsgs = await Session.messages({ sessionID: parent.id })
        const forkMsgs = await Session.messages({ sessionID: forked.id })

        // Same number of messages
        expect(forkMsgs.length).toBe(parentMsgs.length)
        // Same text content
        const parentTexts = parentMsgs.flatMap(m => m.parts.filter(p => p.type === "text").map(p => (p as any).text))
        const forkTexts = forkMsgs.flatMap(m => m.parts.filter(p => p.type === "text").map(p => (p as any).text))
        expect(forkTexts).toEqual(parentTexts)
      },
    })
  })

  test("forked session title gets (fork #1) suffix", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        const parent = await Session.create({ title: "my session" })
        await seedUser(parent.id)
        const forked = await Session.fork({ sessionID: parent.id })
        expect(forked.title).toBe("my session (fork #1)")
      },
    })
  })

  test("forking a forked session increments the fork number", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        const parent = await Session.create({ title: "base" })
        await seedUser(parent.id)
        const fork1 = await Session.fork({ sessionID: parent.id })
        expect(fork1.title).toBe("base (fork #1)")

        const fork2 = await Session.fork({ sessionID: fork1.id })
        expect(fork2.title).toBe("base (fork #2)")
      },
    })
  })

  test("fork with messageID only copies messages before that ID", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        const parent = await Session.create({})
        const mid1 = await seedUser(parent.id, "before")
        const mid2 = await seedUser(parent.id, "after")

        // Fork up to (but not including) mid2
        const forked = await Session.fork({ sessionID: parent.id, messageID: mid2 })

        const forkMsgs = await Session.messages({ sessionID: forked.id })
        const texts = forkMsgs.flatMap(m => m.parts.filter(p => p.type === "text").map(p => (p as any).text))

        expect(texts).toContain("before")
        expect(texts).not.toContain("after")
      },
    })
  })
})

// ---------------------------------------------------------------------------
// 2. Fork mode flag guard
// ---------------------------------------------------------------------------
describe("task fork mode — flag guard", () => {
  test("OPENCODE_FORK_SUBAGENT flag is read dynamically", () => {
    const prev = process.env.OPENCODE_FORK_SUBAGENT
    process.env.OPENCODE_FORK_SUBAGENT = "1"
    const { Flag } = require("../../src/flag/flag")
    expect(Flag.OPENCODE_FORK_SUBAGENT).toBe(true)

    process.env.OPENCODE_FORK_SUBAGENT = "0"
    expect(Flag.OPENCODE_FORK_SUBAGENT).toBe(false)

    delete process.env.OPENCODE_FORK_SUBAGENT
    expect(Flag.OPENCODE_FORK_SUBAGENT).toBe(false)

    if (prev === undefined) delete process.env.OPENCODE_FORK_SUBAGENT
    else process.env.OPENCODE_FORK_SUBAGENT = prev
  })
})

// ---------------------------------------------------------------------------
// 3. Anti-recursion guard
// ---------------------------------------------------------------------------
describe("Session.fork — anti-recursion via title", () => {
  test("forked session title contains '(fork #'", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        const parent = await Session.create({ title: "root" })
        await seedUser(parent.id)
        const forked = await Session.fork({ sessionID: parent.id })

        // The anti-recursion guard in task.ts checks for "(fork #" in title
        expect(forked.title?.includes("(fork #")).toBe(true)
      },
    })
  })
})
