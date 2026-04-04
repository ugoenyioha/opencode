import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Team } from "../../src/team"
import { Session } from "../../src/session"
import { Env } from "../../src/env"
import { Log } from "../../src/util/log"
import { Identifier } from "../../src/id/id"
import { Bus } from "../../src/bus"
import {
  TeamEvent,
  encodeStructured,
  parseStructuredContent,
  isStructuredContent,
  newRequestId,
  type StructuredMessage,
} from "../../src/team/events"
import { TeamMessaging } from "../../src/team/messaging"
import {
  TeamMessageTool,
  TeamModeSetTool,
  TeamPermissionResponseTool,
} from "../../src/tool/team"

Log.init({ print: false })
const projectRoot = path.join(__dirname, "../..")

let counter = 0
function uniqueName(base: string): string {
  return `${base}-${Date.now()}-${++counter}`
}

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

async function seedUserMessage(sessionID: string) {
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
// 1. Wire format helpers
// ---------------------------------------------------------------------------
describe("encodeStructured / parseStructuredContent / isStructuredContent", () => {
  test("encodeStructured produces valid JSON with __structured=true", () => {
    const msg: StructuredMessage = {
      type: "shutdown_request",
      request_id: "req_abc",
      reason: "done",
    }
    const wire = encodeStructured(msg, "Please shut down.")
    const parsed = JSON.parse(wire)
    expect(parsed.__structured).toBe(true)
    expect(parsed.msg.type).toBe("shutdown_request")
    expect(parsed.msg.request_id).toBe("req_abc")
    expect(parsed.text).toBe("Please shut down.")
  })

  test("parseStructuredContent returns envelope for valid structured content", () => {
    const msg: StructuredMessage = { type: "mode_set", mode: "plan" }
    const wire = encodeStructured(msg, "Switching to plan mode.")
    const envelope = parseStructuredContent(wire)
    expect(envelope).not.toBeNull()
    expect(envelope!.__structured).toBe(true)
    expect(envelope!.msg.type).toBe("mode_set")
    expect((envelope!.msg as { mode: string }).mode).toBe("plan")
    expect(envelope!.text).toBe("Switching to plan mode.")
  })

  test("parseStructuredContent returns null for plain text", () => {
    expect(parseStructuredContent("hello world")).toBeNull()
    expect(parseStructuredContent("")).toBeNull()
    expect(parseStructuredContent("{}")).toBeNull()
    expect(parseStructuredContent('{"type":"foo"}')).toBeNull()
  })

  test("isStructuredContent correctly identifies structured wire content", () => {
    const wire = encodeStructured({ type: "idle_notification", summary: "done", idle_reason: "completed" }, "idle")
    expect(isStructuredContent(wire)).toBe(true)
    expect(isStructuredContent("plain text")).toBe(false)
    expect(isStructuredContent("{}")).toBe(false)
    expect(isStructuredContent("")).toBe(false)
  })

  test("newRequestId generates unique non-empty IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => newRequestId()))
    expect(ids.size).toBe(100)
    for (const id of ids) {
      expect(id.startsWith("req_")).toBe(true)
    }
  })

  test("all 9 structured message types round-trip through encode/parse", () => {
    const messages: StructuredMessage[] = [
      { type: "shutdown_request", request_id: "r1" },
      { type: "shutdown_response", request_id: "r1", approve: true },
      { type: "plan_approval_request", request_id: "r2", plan: "my plan" },
      { type: "plan_approval_response", request_id: "r2", approve: false, feedback: "needs work" },
      { type: "permission_request", request_id: "r3", tool_name: "bash", tool_input: '{"command":"ls"}' },
      { type: "permission_response", request_id: "r3", allow: true },
      { type: "mode_set", mode: "auto" },
      { type: "idle_notification", summary: "all done", idle_reason: "completed" },
      { type: "task_assignment", task_id: "t1", content: "do the thing", assigned_by: "lead" },
    ]

    for (const msg of messages) {
      const wire = encodeStructured(msg, `text for ${msg.type}`)
      const envelope = parseStructuredContent(wire)
      expect(envelope).not.toBeNull()
      expect(envelope!.msg.type).toBe(msg.type)
      expect(envelope!.text).toBe(`text for ${msg.type}`)
    }
  })
})

// ---------------------------------------------------------------------------
// 2. TeamMessaging.sendStructured — inbox + injection
// ---------------------------------------------------------------------------
describe("TeamMessaging.sendStructured", () => {
  test("structured message is stored as JSON in inbox, rendered as text in session", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        const name = uniqueName("struct-send")
        const lead = await Session.create({})
        const member = await Session.create({ parentID: lead.id })
        await Team.create({ name, leadSessionID: lead.id })
        await Team.addMember(name, { name: "worker", sessionID: member.id, agent: "general", status: "busy" })
        await seedUserMessage(lead.id)
        await seedUserMessage(member.id)

        // Lead sends a structured shutdown_request to worker
        const rid = newRequestId()
        await TeamMessaging.sendStructured({
          teamName: name,
          from: "lead",
          to: "worker",
          msg: { type: "shutdown_request", request_id: rid, reason: "work done" },
        })

        // Inbox should contain the JSON envelope (not plain text)
        const { Inbox } = await import("../../src/team/inbox")
        const unread = await Inbox.unread(name, "worker")
        expect(unread.length).toBe(1)
        expect(isStructuredContent(unread[0].text)).toBe(true)
        const envelope = parseStructuredContent(unread[0].text)
        expect(envelope!.msg.type).toBe("shutdown_request")
        expect((envelope!.msg as { request_id: string }).request_id).toBe(rid)

        // Session should contain readable text, NOT raw JSON
        const msgs = await Session.messages({ sessionID: member.id })
        const teamMsgs = msgs.filter(m => m.info.role === "user" && m.parts.some(p =>
          (p as any).text?.includes("[Team message from lead]")
        ))
        expect(teamMsgs.length).toBeGreaterThan(0)
        const injectedText = teamMsgs[0].parts.find(p => (p as any).text?.includes("[Team message from lead]")) as any
        // Should contain the human-readable shutdown instruction, not raw JSON
        expect(injectedText.text).toContain("shut down")
        expect(injectedText.text).toContain(rid)
        expect(injectedText.text).not.toContain('"__structured"')

        await Team.setMemberStatus(name, "worker", "shutdown")
        await Team.cleanup(name).catch(() => {})
      },
    })
  })

  test("TeamMessaging.pending returns rendered text and structured envelope", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        const name = uniqueName("struct-pending")
        const lead = await Session.create({})
        const member = await Session.create({ parentID: lead.id })
        await Team.create({ name, leadSessionID: lead.id })
        await Team.addMember(name, { name: "worker", sessionID: member.id, agent: "general", status: "busy" })
        await seedUserMessage(lead.id)
        await seedUserMessage(member.id)

        const rid = newRequestId()
        await TeamMessaging.sendStructured({
          teamName: name,
          from: "lead",
          to: "worker",
          msg: { type: "plan_approval_response", request_id: rid, approve: true },
        })

        const pending = await TeamMessaging.pending(member.id)
        expect(pending.length).toBe(1)
        // text should be human-readable
        expect(pending[0].text).toContain("Plan approved")
        expect(pending[0].text).not.toContain('"__structured"')
        // structured envelope should be present
        expect(pending[0].structured).not.toBeUndefined()
        expect(pending[0].structured!.msg.type).toBe("plan_approval_response")

        await Team.setMemberStatus(name, "worker", "shutdown")
        await Team.cleanup(name).catch(() => {})
      },
    })
  })

  test("StructuredMessageSent bus event fires with correct messageType", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        const name = uniqueName("struct-bus")
        const lead = await Session.create({})
        const member = await Session.create({ parentID: lead.id })
        await Team.create({ name, leadSessionID: lead.id })
        await Team.addMember(name, { name: "worker", sessionID: member.id, agent: "general", status: "busy" })
        await seedUserMessage(lead.id)
        await seedUserMessage(member.id)

        let busEvent: any = null
        const unsub = Bus.subscribe(TeamEvent.StructuredMessageSent, (evt) => { busEvent = evt.properties })

        await TeamMessaging.sendStructured({
          teamName: name,
          from: "lead",
          to: "worker",
          msg: { type: "mode_set", mode: "auto" },
        })

        expect(busEvent).not.toBeNull()
        expect(busEvent.teamName).toBe(name)
        expect(busEvent.from).toBe("lead")
        expect(busEvent.to).toBe("worker")
        expect(busEvent.messageType).toBe("mode_set")

        unsub()
        await Team.setMemberStatus(name, "worker", "shutdown")
        await Team.cleanup(name).catch(() => {})
      },
    })
  })

  test("PermissionRequest bus event fires for permission_request type", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        const name = uniqueName("struct-perm-req")
        const lead = await Session.create({})
        const member = await Session.create({ parentID: lead.id })
        await Team.create({ name, leadSessionID: lead.id })
        await Team.addMember(name, { name: "worker", sessionID: member.id, agent: "general", status: "busy" })
        await seedUserMessage(lead.id)
        await seedUserMessage(member.id)

        let permEvent: any = null
        const unsub = Bus.subscribe(TeamEvent.PermissionRequest, (evt) => { permEvent = evt.properties })

        const rid = newRequestId()
        await TeamMessaging.sendStructured({
          teamName: name,
          from: "worker",
          to: "lead",
          msg: { type: "permission_request", request_id: rid, tool_name: "bash", tool_input: '{"command":"rm -rf /"}' },
        })

        expect(permEvent).not.toBeNull()
        expect(permEvent.memberName).toBe("worker")
        expect(permEvent.requestId).toBe(rid)
        expect(permEvent.toolName).toBe("bash")

        unsub()
        await Team.setMemberStatus(name, "worker", "shutdown")
        await Team.cleanup(name).catch(() => {})
      },
    })
  })
})

// ---------------------------------------------------------------------------
// 3. TeamMessaging.broadcastStructured — mode_set to all teammates
// ---------------------------------------------------------------------------
describe("TeamMessaging.broadcastStructured", () => {
  test("mode_set broadcast reaches all active members, skips sender and shutdown members", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        const name = uniqueName("struct-broadcast")
        const lead = await Session.create({})
        const m1 = await Session.create({ parentID: lead.id })
        const m2 = await Session.create({ parentID: lead.id })
        const m3 = await Session.create({ parentID: lead.id })
        await Team.create({ name, leadSessionID: lead.id })
        await Team.addMember(name, { name: "worker1", sessionID: m1.id, agent: "general", status: "busy" })
        await Team.addMember(name, { name: "worker2", sessionID: m2.id, agent: "general", status: "busy" })
        await Team.addMember(name, { name: "worker3", sessionID: m3.id, agent: "general", status: "shutdown" })
        await seedUserMessage(lead.id)
        await seedUserMessage(m1.id)
        await seedUserMessage(m2.id)
        await seedUserMessage(m3.id)

        let modeEvents = 0
        const unsub = Bus.subscribe(TeamEvent.ModeSet, () => { modeEvents++ })

        await TeamMessaging.broadcastStructured({
          teamName: name,
          from: "lead",
          msg: { type: "mode_set", mode: "plan" },
        })

        // ModeSet event should have fired once
        expect(modeEvents).toBe(1)

        // worker1 and worker2 should have received it; worker3 (shutdown) should not
        const { Inbox } = await import("../../src/team/inbox")
        const w1Unread = await Inbox.unread(name, "worker1")
        const w2Unread = await Inbox.unread(name, "worker2")
        const w3Unread = await Inbox.unread(name, "worker3")

        expect(w1Unread.length).toBe(1)
        expect(w2Unread.length).toBe(1)
        expect(w3Unread.length).toBe(0)

        // Verify structured content
        expect(isStructuredContent(w1Unread[0].text)).toBe(true)
        const env = parseStructuredContent(w1Unread[0].text)
        expect(env!.msg.type).toBe("mode_set")
        expect((env!.msg as { mode: string }).mode).toBe("plan")

        unsub()
        await Team.setMemberStatus(name, "worker1", "shutdown")
        await Team.setMemberStatus(name, "worker2", "shutdown")
        await Team.cleanup(name).catch(() => {})
      },
    })
  })
})

// ---------------------------------------------------------------------------
// 4. team_message tool — structured payload via tool
// ---------------------------------------------------------------------------
describe("TeamMessageTool with structured payload", () => {
  test("shutdown_request via tool creates structured inbox message", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        const name = uniqueName("tool-struct-shutdown")
        const lead = await Session.create({})
        const member = await Session.create({ parentID: lead.id })
        await Team.create({ name, leadSessionID: lead.id })
        await Team.addMember(name, { name: "worker", sessionID: member.id, agent: "general", status: "busy" })
        await seedUserMessage(lead.id)
        await seedUserMessage(member.id)

        const tool = await TeamMessageTool.init()
        const result = await tool.execute(
          { to: "worker", structured: { type: "shutdown_request" } },
          mockCtx(lead.id),
        )

        expect(result.title).toContain("shutdown_request")
        expect(result.output).toContain("worker")

        // Verify inbox contains structured message
        const { Inbox } = await import("../../src/team/inbox")
        const unread = await Inbox.unread(name, "worker")
        expect(unread.length).toBe(1)
        expect(isStructuredContent(unread[0].text)).toBe(true)
        const envelope = parseStructuredContent(unread[0].text)
        expect(envelope!.msg.type).toBe("shutdown_request")
        // request_id should have been auto-generated
        expect((envelope!.msg as { request_id: string }).request_id).toBeTruthy()

        await Team.setMemberStatus(name, "worker", "shutdown")
        await Team.cleanup(name).catch(() => {})
      },
    })
  })

  test("plan_approval_response via tool — approve=false includes feedback", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        const name = uniqueName("tool-struct-plan-rej")
        const lead = await Session.create({})
        const member = await Session.create({ parentID: lead.id })
        await Team.create({ name, leadSessionID: lead.id })
        await Team.addMember(name, { name: "planner", sessionID: member.id, agent: "general", status: "busy" })
        await seedUserMessage(lead.id)
        await seedUserMessage(member.id)

        const tool = await TeamMessageTool.init()
        const rid = "req_test_123"
        const result = await tool.execute(
          {
            to: "planner",
            structured: {
              type: "plan_approval_response",
              request_id: rid,
              approve: false,
              feedback: "Too risky — use a safer approach",
            },
          },
          mockCtx(lead.id),
        )

        expect(result.title).toContain("plan_approval_response")

        const { Inbox } = await import("../../src/team/inbox")
        const unread = await Inbox.unread(name, "planner")
        expect(unread.length).toBe(1)
        const envelope = parseStructuredContent(unread[0].text)
        expect(envelope!.msg.type).toBe("plan_approval_response")
        const msg = envelope!.msg as { approve: boolean; feedback?: string }
        expect(msg.approve).toBe(false)
        expect(msg.feedback).toBe("Too risky — use a safer approach")

        await Team.setMemberStatus(name, "planner", "shutdown")
        await Team.cleanup(name).catch(() => {})
      },
    })
  })

  test("plain text path still works when no structured field provided", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        const name = uniqueName("tool-plain-text")
        const lead = await Session.create({})
        const member = await Session.create({ parentID: lead.id })
        await Team.create({ name, leadSessionID: lead.id })
        await Team.addMember(name, { name: "worker", sessionID: member.id, agent: "general", status: "busy" })
        await seedUserMessage(lead.id)
        await seedUserMessage(member.id)

        const tool = await TeamMessageTool.init()
        const result = await tool.execute(
          { to: "worker", text: "How is the refactor going?" },
          mockCtx(lead.id),
        )

        expect(result.title).toContain("sent to worker")

        const { Inbox } = await import("../../src/team/inbox")
        const unread = await Inbox.unread(name, "worker")
        expect(unread.length).toBe(1)
        // Plain text should NOT be structured
        expect(isStructuredContent(unread[0].text)).toBe(false)
        expect(unread[0].text).toBe("How is the refactor going?")

        await Team.setMemberStatus(name, "worker", "shutdown")
        await Team.cleanup(name).catch(() => {})
      },
    })
  })

  test("error: neither text nor structured provided", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        const name = uniqueName("tool-no-payload")
        const lead = await Session.create({})
        await Team.create({ name, leadSessionID: lead.id })

        const tool = await TeamMessageTool.init()
        const result = await tool.execute({ to: "someone" } as any, mockCtx(lead.id))

        expect(result.title).toBe("Error")
        expect(result.output).toContain("text or structured must be provided")

        await Team.cleanup(name).catch(() => {})
      },
    })
  })

  test("error: shutdown_response missing approve field", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        const name = uniqueName("tool-struct-missing")
        const lead = await Session.create({})
        await Team.create({ name, leadSessionID: lead.id })

        const tool = await TeamMessageTool.init()
        const result = await tool.execute(
          { to: "lead", structured: { type: "shutdown_response", request_id: "r1" } as any },
          mockCtx(lead.id),
        )

        expect(result.title).toBe("Error")
        expect(result.output).toContain("approve")

        await Team.cleanup(name).catch(() => {})
      },
    })
  })
})

// ---------------------------------------------------------------------------
// 5. TeamModeSetTool
// ---------------------------------------------------------------------------
describe("TeamModeSetTool", () => {
  test("broadcasts mode_set to all active teammates, fires ModeSet event", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        const name = uniqueName("modeset-tool")
        const lead = await Session.create({})
        const m1 = await Session.create({ parentID: lead.id })
        const m2 = await Session.create({ parentID: lead.id })
        await Team.create({ name, leadSessionID: lead.id })
        await Team.addMember(name, { name: "worker1", sessionID: m1.id, agent: "general", status: "busy" })
        await Team.addMember(name, { name: "worker2", sessionID: m2.id, agent: "general", status: "busy" })
        await seedUserMessage(lead.id)
        await seedUserMessage(m1.id)
        await seedUserMessage(m2.id)

        let modeEvents: any[] = []
        const unsub = Bus.subscribe(TeamEvent.ModeSet, (evt) => { modeEvents.push(evt.properties) })

        const tool = await TeamModeSetTool.init()
        const result = await tool.execute({ mode: "auto" }, mockCtx(lead.id))

        expect(result.title).toContain("auto")
        expect(result.output).toContain("2 active teammate(s)")
        expect(modeEvents.length).toBe(1)
        expect(modeEvents[0].mode).toBe("auto")

        const { Inbox } = await import("../../src/team/inbox")
        const w1 = await Inbox.unread(name, "worker1")
        const w2 = await Inbox.unread(name, "worker2")
        expect(w1.length).toBe(1)
        expect(w2.length).toBe(1)
        const env = parseStructuredContent(w1[0].text)
        expect(env!.msg.type).toBe("mode_set")
        expect((env!.msg as { mode: string }).mode).toBe("auto")

        unsub()
        await Team.setMemberStatus(name, "worker1", "shutdown")
        await Team.setMemberStatus(name, "worker2", "shutdown")
        await Team.cleanup(name).catch(() => {})
      },
    })
  })

  test("error: non-lead cannot set modes", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        const name = uniqueName("modeset-non-lead")
        const lead = await Session.create({})
        const member = await Session.create({ parentID: lead.id })
        await Team.create({ name, leadSessionID: lead.id })
        await Team.addMember(name, { name: "worker", sessionID: member.id, agent: "general", status: "busy" })

        const tool = await TeamModeSetTool.init()
        const result = await tool.execute({ mode: "auto" }, mockCtx(member.id))

        expect(result.title).toBe("Error")
        expect(result.output).toContain("Only the team lead")

        await Team.setMemberStatus(name, "worker", "shutdown")
        await Team.cleanup(name).catch(() => {})
      },
    })
  })
})

// ---------------------------------------------------------------------------
// 6. TeamPermissionResponseTool
// ---------------------------------------------------------------------------
describe("TeamPermissionResponseTool", () => {
  test("sends permission_response structured message and fires PermissionResponse event", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        const name = uniqueName("perm-resp-tool")
        const lead = await Session.create({})
        const member = await Session.create({ parentID: lead.id })
        await Team.create({ name, leadSessionID: lead.id })
        await Team.addMember(name, { name: "worker", sessionID: member.id, agent: "general", status: "busy" })
        await seedUserMessage(lead.id)
        await seedUserMessage(member.id)

        let permRespEvent: any = null
        const unsub = Bus.subscribe(TeamEvent.PermissionResponse, (evt) => { permRespEvent = evt.properties })

        const rid = "req_perm_456"
        const tool = await TeamPermissionResponseTool.init()
        const result = await tool.execute(
          { to: "worker", request_id: rid, allow: true, reason: "Looks safe" },
          mockCtx(lead.id),
        )

        expect(result.title).toContain("ALLOWED")
        expect(result.output).toContain("worker")
        expect(result.output).toContain(rid)

        expect(permRespEvent).not.toBeNull()
        expect(permRespEvent.allow).toBe(true)
        expect(permRespEvent.requestId).toBe(rid)

        const { Inbox } = await import("../../src/team/inbox")
        const unread = await Inbox.unread(name, "worker")
        expect(unread.length).toBe(1)
        const envelope = parseStructuredContent(unread[0].text)
        expect(envelope!.msg.type).toBe("permission_response")
        const msg = envelope!.msg as { allow: boolean; request_id: string; reason?: string }
        expect(msg.allow).toBe(true)
        expect(msg.request_id).toBe(rid)
        expect(msg.reason).toBe("Looks safe")

        unsub()
        await Team.setMemberStatus(name, "worker", "shutdown")
        await Team.cleanup(name).catch(() => {})
      },
    })
  })

  test("deny: allow=false sends DENIED response", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        const name = uniqueName("perm-resp-deny")
        const lead = await Session.create({})
        const member = await Session.create({ parentID: lead.id })
        await Team.create({ name, leadSessionID: lead.id })
        await Team.addMember(name, { name: "worker", sessionID: member.id, agent: "general", status: "busy" })
        await seedUserMessage(lead.id)
        await seedUserMessage(member.id)

        const tool = await TeamPermissionResponseTool.init()
        const result = await tool.execute(
          { to: "worker", request_id: "req_deny_1", allow: false, reason: "Too dangerous" },
          mockCtx(lead.id),
        )

        expect(result.title).toContain("DENIED")

        const { Inbox } = await import("../../src/team/inbox")
        const unread = await Inbox.unread(name, "worker")
        const envelope = parseStructuredContent(unread[0].text)
        expect((envelope!.msg as { allow: boolean }).allow).toBe(false)

        await Team.setMemberStatus(name, "worker", "shutdown")
        await Team.cleanup(name).catch(() => {})
      },
    })
  })

  test("error: non-lead cannot respond to permission requests", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        const name = uniqueName("perm-resp-non-lead")
        const lead = await Session.create({})
        const member = await Session.create({ parentID: lead.id })
        await Team.create({ name, leadSessionID: lead.id })
        await Team.addMember(name, { name: "worker", sessionID: member.id, agent: "general", status: "busy" })

        const tool = await TeamPermissionResponseTool.init()
        const result = await tool.execute(
          { to: "lead", request_id: "req_1", allow: true },
          mockCtx(member.id),
        )

        expect(result.title).toBe("Error")
        expect(result.output).toContain("Only the team lead")

        await Team.setMemberStatus(name, "worker", "shutdown")
        await Team.cleanup(name).catch(() => {})
      },
    })
  })
})
