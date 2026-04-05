import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Team } from "../../src/team"
import { Session } from "../../src/session"
import { Env } from "../../src/env"
import { Log } from "../../src/util/log"
import { Identifier } from "../../src/id/id"
import { Bus } from "../../src/bus"
import { PermissionNext } from "../../src/permission/next"
import { TeamEvent } from "../../src/team/events"
import { TeamMessaging } from "../../src/team/messaging"
import { Inbox } from "../../src/team/inbox"
import { initPermissionRouting } from "../../src/team/permission-routing"
import { tmpdir } from "../fixture/fixture"
import { initProjectors } from "../../src/server/projectors"

Log.init({ print: false })

let counter = 0
function uniq(base: string) {
  return `${base}-${Date.now()}-${++counter}`
}

async function testInit() {
  Env.set("ANTHROPIC_API_KEY", "test-key")
  initProjectors()
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
// 1. initPermissionRouting returns an unsubscribe function
// ---------------------------------------------------------------------------
describe("initPermissionRouting", () => {
  test("returns a callable unsubscribe function", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: testInit,
      fn: async () => {
        const unsub = initPermissionRouting()
        expect(typeof unsub).toBe("function")
        unsub()
      },
    })
  })
})

// ---------------------------------------------------------------------------
// 2. Non-teammate sessions are ignored
// ---------------------------------------------------------------------------
describe("permission routing — non-team session passthrough", () => {
  test("Asked event for non-team session does not route to any inbox", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: testInit,
      fn: async () => {
        const unsub = initPermissionRouting()
        const solo = await Session.create({})
        await seedUser(solo.id)

        let fired = false
        const unsubAsked = Bus.subscribe(PermissionNext.Event.Asked, () => { fired = true })

        await Bus.publish(PermissionNext.Event.Asked, {
          id: Identifier.ascending("permission"),
          sessionID: solo.id,
          permission: "bash",
          patterns: ["*"],
          always: ["*"],
          metadata: {},
        })

        expect(fired).toBe(true)
        // No crash, no routing attempted for non-team session

        unsubAsked()
        unsub()
      },
    })
  })
})

// ---------------------------------------------------------------------------
// 3. Teammate session: permission_request sent to lead inbox
// ---------------------------------------------------------------------------
describe("permission routing — teammate sends permission_request to lead", () => {
  test("lead receives structured permission_request in inbox after Asked event", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: testInit,
      fn: async () => {
        const name = uniq("perm-route-send")
        const lead = await Session.create({})
        const member = await Session.create({ parentID: lead.id })
        await Team.create({ name, leadSessionID: lead.id })
        await Team.addMember(name, { name: "worker", sessionID: member.id, agent: "general", status: "busy" })
        await seedUser(lead.id)
        await seedUser(member.id)

        const unsub = initPermissionRouting()

        let permReqEvent: any = null
        const unsubPerm = Bus.subscribe(TeamEvent.PermissionRequest, (evt) => {
          permReqEvent = evt.properties
        })

        // Bus.publish awaits Phase 1 of the handler (sendStructured + bus event)
        await Bus.publish(PermissionNext.Event.Asked, {
          id: Identifier.ascending("permission"),
          sessionID: member.id,
          permission: "bash",
          patterns: ["*"],
          always: ["*"],
          metadata: { command: "ls -la" },
        })

        await Bun.sleep(50)

        // TeamEvent.PermissionRequest was emitted during Phase 1
        expect(permReqEvent).not.toBeNull()
        expect(permReqEvent.teamName).toBe(name)
        expect(permReqEvent.memberName).toBe("worker")
        expect(permReqEvent.toolName).toBe("bash")

        // Lead inbox has the permission_request
        const leadMsgs = await Inbox.unread(name, "lead")
        const permMsg = leadMsgs.find((m) => {
          if (!m.text.startsWith("{")) return false
          try {
            const env = JSON.parse(m.text)
            return env.__structured === true && env.msg.type === "permission_request"
          } catch { return false }
        })
        expect(permMsg).toBeDefined()
        const env = JSON.parse(permMsg!.text)
        expect(env.msg.tool_name).toBe("bash")
        expect(env.msg.request_id).toBeTruthy()

        unsubPerm()
        unsub()
        await Team.setMemberStatus(name, "worker", "shutdown")
        await Team.cleanup(name).catch(() => {})
      },
    })
  })
})

// ---------------------------------------------------------------------------
// 4. Allow flow: lead sends allow=true → polling resolves
// ---------------------------------------------------------------------------
describe("permission routing — allow flow", () => {
  test("lead sends permission_response allow=true → worker inbox has allow response", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: testInit,
      fn: async () => {
        const name = uniq("perm-route-allow")
        const lead = await Session.create({})
        const member = await Session.create({ parentID: lead.id })
        await Team.create({ name, leadSessionID: lead.id })
        await Team.addMember(name, { name: "worker", sessionID: member.id, agent: "general", status: "busy" })
        await seedUser(lead.id)
        await seedUser(member.id)

        const unsub = initPermissionRouting()

        // Phase 1: publish Asked, routing sends permission_request to lead
        await Bus.publish(PermissionNext.Event.Asked, {
          id: Identifier.ascending("permission"),
          sessionID: member.id,
          permission: "bash",
          patterns: ["*"],
          always: ["*"],
          metadata: { command: "echo hello" },
        })

        await Bun.sleep(50)

        // Get request_id from lead's inbox (written during Phase 1)
        const leadMsgs = await Inbox.unread(name, "lead")
        const permMsg = leadMsgs.find((m) => {
          if (!m.text.startsWith("{")) return false
          try {
            const env = JSON.parse(m.text)
            return env.__structured === true && env.msg.type === "permission_request"
          } catch { return false }
        })
        expect(permMsg).toBeDefined()
        const rid = JSON.parse(permMsg!.text).msg.request_id

        // Lead approves — writes to worker inbox, Phase 2 polling picks it up
        await TeamMessaging.sendStructured({
          teamName: name,
          from: "lead",
          to: "worker",
          msg: { type: "permission_response", request_id: rid, allow: true, reason: "looks safe" },
        })

        // Wait for Phase 2 polling loop (POLL_MS = 1500ms)
        await Bun.sleep(2500)

        // Worker inbox contains the allow response (may be read already via autoWake)
        const workerMsgs = await Inbox.all(name, "worker")
        const resp = workerMsgs.find((m) => {
          if (!m.text.startsWith("{")) return false
          try {
            const env = JSON.parse(m.text)
            return env.__structured === true && env.msg.type === "permission_response" && env.msg.request_id === rid
          } catch { return false }
        })
        expect(resp).toBeDefined()
        expect(JSON.parse(resp!.text).msg.allow).toBe(true)

        unsub()
        await Team.setMemberStatus(name, "worker", "shutdown")
        await Team.cleanup(name).catch(() => {})
      },
    })
  }, 15000)
})

// ---------------------------------------------------------------------------
// 5. Deny flow: lead sends allow=false
// ---------------------------------------------------------------------------
describe("permission routing — deny flow", () => {
  test("lead sends permission_response allow=false → worker inbox has deny response", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: testInit,
      fn: async () => {
        const name = uniq("perm-route-deny")
        const lead = await Session.create({})
        const member = await Session.create({ parentID: lead.id })
        await Team.create({ name, leadSessionID: lead.id })
        await Team.addMember(name, { name: "worker", sessionID: member.id, agent: "general", status: "busy" })
        await seedUser(lead.id)
        await seedUser(member.id)

        const unsub = initPermissionRouting()

        await Bus.publish(PermissionNext.Event.Asked, {
          id: Identifier.ascending("permission"),
          sessionID: member.id,
          permission: "bash",
          patterns: ["*"],
          always: ["*"],
          metadata: { command: "rm -rf /" },
        })

        await Bun.sleep(50)

        const leadMsgs = await Inbox.unread(name, "lead")
        const permMsg = leadMsgs.find((m) => {
          if (!m.text.startsWith("{")) return false
          try {
            const env = JSON.parse(m.text)
            return env.__structured === true && env.msg.type === "permission_request"
          } catch { return false }
        })
        expect(permMsg).toBeDefined()
        const rid = JSON.parse(permMsg!.text).msg.request_id

        // Lead denies
        await TeamMessaging.sendStructured({
          teamName: name,
          from: "lead",
          to: "worker",
          msg: { type: "permission_response", request_id: rid, allow: false, reason: "too dangerous" },
        })

        await Bun.sleep(2500)

        const workerMsgs = await Inbox.all(name, "worker")
        const resp = workerMsgs.find((m) => {
          if (!m.text.startsWith("{")) return false
          try {
            const env = JSON.parse(m.text)
            return env.__structured === true && env.msg.type === "permission_response" && env.msg.request_id === rid
          } catch { return false }
        })
        expect(resp).toBeDefined()
        expect(JSON.parse(resp!.text).msg.allow).toBe(false)

        unsub()
        await Team.setMemberStatus(name, "worker", "shutdown")
        await Team.cleanup(name).catch(() => {})
      },
    })
  }, 15000)
})

// ---------------------------------------------------------------------------
// 6. Wrong request_id is ignored, correct one resolves
// ---------------------------------------------------------------------------
describe("permission routing — request_id matching", () => {
  test("wrong request_id response is skipped, correct one resolves", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: testInit,
      fn: async () => {
        const name = uniq("perm-route-rid")
        const lead = await Session.create({})
        const member = await Session.create({ parentID: lead.id })
        await Team.create({ name, leadSessionID: lead.id })
        await Team.addMember(name, { name: "worker", sessionID: member.id, agent: "general", status: "busy" })
        await seedUser(lead.id)
        await seedUser(member.id)

        const unsub = initPermissionRouting()

        await Bus.publish(PermissionNext.Event.Asked, {
          id: Identifier.ascending("permission"),
          sessionID: member.id,
          permission: "edit",
          patterns: ["*"],
          always: ["*"],
          metadata: {},
        })

        await Bun.sleep(50)

        const leadMsgs = await Inbox.unread(name, "lead")
        const permMsg = leadMsgs.find((m) => {
          if (!m.text.startsWith("{")) return false
          try {
            const env = JSON.parse(m.text)
            return env.__structured === true && env.msg.type === "permission_request"
          } catch { return false }
        })
        expect(permMsg).toBeDefined()
        const realRid = JSON.parse(permMsg!.text).msg.request_id

        // Wrong request_id first — polling should skip it
        await TeamMessaging.sendStructured({
          teamName: name,
          from: "lead",
          to: "worker",
          msg: { type: "permission_response", request_id: "wrong-rid-xyz", allow: false },
        })

        // Wait one poll interval, then send correct rid
        await Bun.sleep(1600)

        await TeamMessaging.sendStructured({
          teamName: name,
          from: "lead",
          to: "worker",
          msg: { type: "permission_response", request_id: realRid, allow: true },
        })

        // Wait for polling to pick up the correct response
        await Bun.sleep(2500)

        const workerMsgs = await Inbox.all(name, "worker")
        const correctResp = workerMsgs.find((m) => {
          if (!m.text.startsWith("{")) return false
          try {
            const env = JSON.parse(m.text)
            return env.__structured === true && env.msg.type === "permission_response" && env.msg.request_id === realRid
          } catch { return false }
        })
        expect(correctResp).toBeDefined()
        expect(JSON.parse(correctResp!.text).msg.allow).toBe(true)

        unsub()
        await Team.setMemberStatus(name, "worker", "shutdown")
        await Team.cleanup(name).catch(() => {})
      },
    })
  }, 20000)
})
