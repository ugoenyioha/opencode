import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Team } from "../../src/team"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { TeamWaitTool } from "../../src/tool/team_wait"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

function mockCtx(sessionID: string) {
  return {
    sessionID,
    messageID: Identifier.ascending("message"),
    agent: "general",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
    ask: async () => {},
  } as any
}

describe("TeamWaitTool", () => {
  test("returns immediately when no teammates exist", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await TeamWaitTool.init()
        const lead = await Session.create({})
        await Team.create({ name: "wait-empty", leadSessionID: lead.id })

        const result = await tool.execute({}, mockCtx(lead.id))

        expect(result.title).toBe("All teammates finished")
        expect(result.output).toContain('All 0 teammate(s) in team "wait-empty" have finished their work.')
        expect(result.metadata.completed).toBeTrue()
        expect(result.metadata.teammateCount).toBe(0)

        await Team.cleanup("wait-empty")
      },
    })
  })

  test("returns when all teammates are in terminal execution states", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await TeamWaitTool.init()
        const lead = await Session.create({})
        await Team.create({ name: "wait-terminal", leadSessionID: lead.id })

        const completed = await Session.create({ parentID: lead.id })
        await Team.addMember("wait-terminal", {
          name: "done",
          sessionID: completed.id,
          agent: "general",
          status: "ready",
          execution_status: "completed",
        })

        const failed = await Session.create({ parentID: lead.id })
        await Team.addMember("wait-terminal", {
          name: "broken",
          sessionID: failed.id,
          agent: "general",
          status: "error",
          execution_status: "failed",
        })

        const result = await tool.execute({ timeout: 1 }, mockCtx(lead.id))

        expect(result.title).toBe("All teammates finished")
        expect(result.output).toContain("- done: idle and ready (completed work)")
        expect(result.output).toContain("- broken: errored (failed)")

        await Team.setMemberStatus("wait-terminal", "done", "shutdown")
        await Team.setMemberStatus("wait-terminal", "broken", "shutdown")
        await Team.cleanup("wait-terminal")
      },
    })
  })

  test("times out after specified timeout period", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await TeamWaitTool.init()
        const lead = await Session.create({})
        await Team.create({ name: "wait-timeout", leadSessionID: lead.id })

        const active = await Session.create({ parentID: lead.id })
        await Team.addMember("wait-timeout", {
          name: "running",
          sessionID: active.id,
          agent: "general",
          status: "busy",
          execution_status: "running",
        })

        const result = await tool.execute({ timeout: 0.05 }, mockCtx(lead.id))

        expect(result.title).toBe("Wait timeout")
        expect(result.output).toContain("Timeout after")
        expect(result.output).toContain("running (running)")
        expect(result.metadata.timeout).toBeTrue()
        expect(result.metadata.activeCount).toBe(1)

        await Team.setMemberStatus("wait-timeout", "running", "shutdown")
        await Team.cleanup("wait-timeout")
      },
    })
  })

  test("reports each teammate final status output", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await TeamWaitTool.init()
        const lead = await Session.create({})
        await Team.create({ name: "wait-report", leadSessionID: lead.id })

        const one = await Session.create({ parentID: lead.id })
        await Team.addMember("wait-report", {
          name: "one",
          sessionID: one.id,
          agent: "general",
          status: "ready",
          execution_status: "completed",
        })

        const two = await Session.create({ parentID: lead.id })
        await Team.addMember("wait-report", {
          name: "two",
          sessionID: two.id,
          agent: "general",
          status: "shutdown",
          execution_status: "cancelled",
        })

        const three = await Session.create({ parentID: lead.id })
        await Team.addMember("wait-report", {
          name: "three",
          sessionID: three.id,
          agent: "general",
          status: "error",
          execution_status: "timed_out",
        })

        const result = await tool.execute({ timeout: 1 }, mockCtx(lead.id))

        expect(result.output).toContain("- one: idle and ready (completed work)")
        expect(result.output).toContain("- two: shutdown (was cancelled)")
        expect(result.output).toContain("- three: errored (timed out)")
        expect(result.metadata.completed).toBeTrue()
        expect(result.metadata.teammateCount).toBe(3)

        await Team.setMemberStatus("wait-report", "one", "shutdown")
        await Team.setMemberStatus("wait-report", "three", "shutdown")
        await Team.cleanup("wait-report")
      },
    })
  })
})
