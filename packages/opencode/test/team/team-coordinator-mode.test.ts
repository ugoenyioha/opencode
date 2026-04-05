import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Team } from "../../src/team"
import { Session } from "../../src/session"
import { Env } from "../../src/env"
import { Log } from "../../src/util/log"
import { Identifier } from "../../src/id/id"
import { CoordinatorMode } from "../../src/team/coordinator"
import { SessionPrompt } from "../../src/session/prompt"
import { Provider } from "../../src/provider/provider"
import { Agent } from "../../src/agent/agent"
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
// 1. CoordinatorMode.ALLOWED_TOOLS contains the expected tools
// ---------------------------------------------------------------------------
describe("CoordinatorMode.ALLOWED_TOOLS", () => {
  test("includes task, read, team_* tools", () => {
    expect(CoordinatorMode.ALLOWED_TOOLS.has("task")).toBe(true)
    expect(CoordinatorMode.ALLOWED_TOOLS.has("read")).toBe(true)
    expect(CoordinatorMode.ALLOWED_TOOLS.has("team_spawn")).toBe(true)
    expect(CoordinatorMode.ALLOWED_TOOLS.has("team_message")).toBe(true)
    expect(CoordinatorMode.ALLOWED_TOOLS.has("team_shutdown")).toBe(true)
    expect(CoordinatorMode.ALLOWED_TOOLS.has("team_cleanup")).toBe(true)
    expect(CoordinatorMode.ALLOWED_TOOLS.has("team_status")).toBe(true)
    expect(CoordinatorMode.ALLOWED_TOOLS.has("team_permission_response")).toBe(true)
  })

  test("excludes write tools", () => {
    expect(CoordinatorMode.ALLOWED_TOOLS.has("bash")).toBe(false)
    expect(CoordinatorMode.ALLOWED_TOOLS.has("write")).toBe(false)
    expect(CoordinatorMode.ALLOWED_TOOLS.has("edit")).toBe(false)
    expect(CoordinatorMode.ALLOWED_TOOLS.has("glob")).toBe(false)
    expect(CoordinatorMode.ALLOWED_TOOLS.has("grep")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. CoordinatorMode.systemPrompt includes required sections
// ---------------------------------------------------------------------------
describe("CoordinatorMode.systemPrompt", () => {
  test("contains team name and key instructions", () => {
    const prompt = CoordinatorMode.systemPrompt("my-team")
    expect(prompt).toContain("my-team")
    expect(prompt).toContain("coordinator")
    expect(prompt).toContain("team_spawn")
    expect(prompt).toContain("team_cleanup")
  })
})

// ---------------------------------------------------------------------------
// 3. Team.create with coordinator=true sets coordinator flag
// ---------------------------------------------------------------------------
describe("Team.create coordinator flag", () => {
  test("team.coordinator is true when created with coordinator=true", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        const name = uniq("coord-create")
        const lead = await Session.create({})
        const team = await Team.create({ name, leadSessionID: lead.id, coordinator: true })

        expect(team.coordinator).toBe(true)

        // Persists across get()
        const loaded = await Team.get(name)
        expect(loaded?.coordinator).toBe(true)

        await Team.cleanup(name).catch(() => {})
      },
    })
  })

  test("team.coordinator is falsy when not specified", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        const name = uniq("coord-default")
        const lead = await Session.create({})
        const team = await Team.create({ name, leadSessionID: lead.id })

        expect(team.coordinator).toBeFalsy()

        await Team.cleanup(name).catch(() => {})
      },
    })
  })
})

// ---------------------------------------------------------------------------
// 4. resolveTools filters to ALLOWED_TOOLS for coordinator lead
// ---------------------------------------------------------------------------
describe("resolveTools — coordinator mode tool filtering", () => {
  test("coordinator lead only gets allowed tools", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
        process.env.OPENCODE_EXPERIMENTAL_AGENT_TEAMS = "1"
      },
      fn: async () => {
        const name = uniq("coord-tools")
        const lead = await Session.create({})
        await seedUser(lead.id)
        await Team.create({ name, leadSessionID: lead.id, coordinator: true })

        const model = await Provider.getModel("anthropic", "claude-sonnet-4-5-20250929").catch(() => null)
        if (!model) {
          // Skip if model not available in test env
          await Team.cleanup(name).catch(() => {})
          return
        }

        const agent = await Agent.get("general")
        const session = await Session.get(lead.id)
        const msgs = await Session.messages({ sessionID: lead.id })

        // Create a minimal processor mock
        const processor = {
          message: { id: Identifier.ascending("message") },
          partFromToolCall: () => null,
        } as any

        const tools = await SessionPrompt.resolveTools({
          agent,
          model,
          session,
          processor,
          bypassAgentCheck: false,
          messages: msgs,
        })

        const toolIds = Object.keys(tools)

        // Should have team tools
        expect(toolIds.some(id => id.startsWith("team_"))).toBe(true)
        expect(toolIds.includes("task")).toBe(true)
        expect(toolIds.includes("read")).toBe(true)

        // Should NOT have write tools
        expect(toolIds.includes("bash")).toBe(false)
        expect(toolIds.includes("write")).toBe(false)
        expect(toolIds.includes("edit")).toBe(false)
        expect(toolIds.includes("glob")).toBe(false)
        expect(toolIds.includes("grep")).toBe(false)

        await Team.cleanup(name).catch(() => {})
      },
    })
  })

  test("non-coordinator lead gets full tool set", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
        process.env.OPENCODE_EXPERIMENTAL_AGENT_TEAMS = "1"
      },
      fn: async () => {
        const name = uniq("normal-tools")
        const lead = await Session.create({})
        await seedUser(lead.id)
        await Team.create({ name, leadSessionID: lead.id }) // no coordinator

        const model = await Provider.getModel("anthropic", "claude-sonnet-4-5-20250929").catch(() => null)
        if (!model) {
          await Team.cleanup(name).catch(() => {})
          return
        }

        const agent = await Agent.get("general")
        const session = await Session.get(lead.id)
        const msgs = await Session.messages({ sessionID: lead.id })
        const processor = {
          message: { id: Identifier.ascending("message") },
          partFromToolCall: () => null,
        } as any

        const tools = await SessionPrompt.resolveTools({
          agent,
          model,
          session,
          processor,
          bypassAgentCheck: false,
          messages: msgs,
        })

        const toolIds = Object.keys(tools)

        // Full tool set — bash/write/edit should be present
        expect(toolIds.includes("bash")).toBe(true)
        expect(toolIds.includes("write")).toBe(true)
        expect(toolIds.includes("edit")).toBe(true)

        await Team.cleanup(name).catch(() => {})
      },
    })
  })
})
