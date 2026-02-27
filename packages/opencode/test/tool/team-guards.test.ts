import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Team } from "../../src/team"
import { Session } from "../../src/session"
import { Log } from "../../src/util/log"
import { Identifier } from "../../src/id/id"
import { TeamSpawnTool } from "../../src/tool/team"
import { tmpdir } from "../fixture/fixture"
import type { Config } from "../../src/config/config"

Log.init({ print: false })

function mockCtx(sessionID: string, messages: any[] = []) {
  return {
    sessionID,
    messageID: Identifier.ascending("message"),
    agent: "general",
    abort: new AbortController().signal,
    messages,
    metadata: () => {},
    ask: async () => {},
  } as any
}

async function seedUserMessage(sessionID: string) {
  const mid = Identifier.ascending("message")
  await Session.updateMessage({
    id: mid,
    sessionID,
    role: "user",
    agent: "general",
    model: { providerID: "anthropic", modelID: "claude-3-5-sonnet-20241022" },
    time: { created: Date.now() },
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: mid,
    sessionID,
    type: "text",
    text: "init",
  })
  return mid
}

describe("Team Guards", () => {
  describe("max_team_members", () => {
    test("blocks spawn when team reaches max members limit", async () => {
      await using tmp = await tmpdir({
        git: true,
        // Type assertion needed because we're writing partial JSON that gets parsed with defaults
        config: {
          server: {
            limits: {
              max_team_members: 2,
            },
          },
        } as Partial<Config.Info>,
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const lead = await Session.create({})
          await seedUserMessage(lead.id)
          await Team.create({ name: "max-members", leadSessionID: lead.id })

          // Add 2 members manually to reach the limit
          await Team.addMember("max-members", {
            name: "worker-1",
            sessionID: "ses_w1",
            agent: "general",
            status: "busy",
          })
          await Team.addMember("max-members", {
            name: "worker-2",
            sessionID: "ses_w2",
            agent: "general",
            status: "busy",
          })

          const messages = [
            {
              info: {
                role: "user",
                model: { providerID: "anthropic", modelID: "claude-3-5-sonnet-20241022" },
              },
              parts: [],
            },
          ]

          const tool = await TeamSpawnTool.init()
          const result = await tool.execute({ name: "worker-3", prompt: "work" }, mockCtx(lead.id, messages))

          expect(result.title).toBe("Error")
          expect(result.output).toContain("maximum of 2 teammates")
          expect(result.metadata.error).toBe("max_team_members_exceeded")
          expect(result.metadata.current).toBe(2)
          expect(result.metadata.limit).toBe(2)

          // Cleanup
          await Team.setMemberStatus("max-members", "worker-1", "shutdown")
          await Team.setMemberStatus("max-members", "worker-2", "shutdown")
          await Team.cleanup("max-members")
        },
      })
    })

    test("allows spawn when below limit", async () => {
      await using tmp = await tmpdir({
        git: true,
        config: {
          server: {
            limits: {
              max_team_members: 5,
            },
          },
        } as Partial<Config.Info>,
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const lead = await Session.create({})
          await seedUserMessage(lead.id)
          await Team.create({ name: "below-limit", leadSessionID: lead.id })

          // Add only 2 members when limit is 5
          await Team.addMember("below-limit", {
            name: "worker-1",
            sessionID: "ses_w1",
            agent: "general",
            status: "busy",
          })
          await Team.addMember("below-limit", {
            name: "worker-2",
            sessionID: "ses_w2",
            agent: "general",
            status: "busy",
          })

          const messages = [
            {
              info: {
                role: "user",
                model: { providerID: "anthropic", modelID: "claude-3-5-sonnet-20241022" },
              },
              parts: [],
            },
          ]

          const tool = await TeamSpawnTool.init()
          const result = await tool.execute({ name: "worker-3", prompt: "work" }, mockCtx(lead.id, messages))

          // Should succeed since we're below the limit
          expect(result.title).toContain("Spawned teammate")
          expect(result.metadata.memberName).toBe("worker-3")

          // Cleanup
          await Team.setMemberStatus("below-limit", "worker-1", "shutdown")
          await Team.setMemberStatus("below-limit", "worker-2", "shutdown")
          await Team.setMemberStatus("below-limit", "worker-3", "shutdown")
          await Team.cleanup("below-limit")
        },
      })
    })

    test("uses default limit of 20 when not configured", async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const lead = await Session.create({})
          await seedUserMessage(lead.id)
          await Team.create({ name: "default-limit", leadSessionID: lead.id })

          const messages = [
            {
              info: {
                role: "user",
                model: { providerID: "anthropic", modelID: "claude-3-5-sonnet-20241022" },
              },
              parts: [],
            },
          ]

          const tool = await TeamSpawnTool.init()
          // With default limit of 20 and 0 members, should succeed
          const result = await tool.execute({ name: "first-worker", prompt: "work" }, mockCtx(lead.id, messages))

          expect(result.title).toContain("Spawned teammate")

          // Cleanup
          await Team.setMemberStatus("default-limit", "first-worker", "shutdown")
          await Team.cleanup("default-limit")
        },
      })
    })
  })
})
