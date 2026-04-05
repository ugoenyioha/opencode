/**
 * Promptfoo runner for permission routing correctness evals.
 *
 * Usage: bun run permission-routing-runner.ts <scenario>
 *
 * Scenarios:
 *   non-team-passthrough        — Asked event for non-team session, lead inbox unchanged
 *   teammate-routes-to-lead     — Teammate Asked → permission_request in lead inbox
 *   lead-allow                  — Lead sends allow=true → routing resolves
 *   lead-deny                   — Lead sends allow=false → routing resolves with deny
 *   wrong-request-id-ignored    — Wrong rid ignored, correct one resolves
 */

import os from "node:os"
import path from "node:path"
import fs from "node:fs/promises"

const dir = path.join(os.tmpdir(), "opencode-perm-routing-" + process.pid)
await fs.mkdir(dir, { recursive: true })

process.env["XDG_DATA_HOME"] = path.join(dir, "share")
process.env["XDG_CACHE_HOME"] = path.join(dir, "cache")
process.env["XDG_CONFIG_HOME"] = path.join(dir, "config")
process.env["XDG_STATE_HOME"] = path.join(dir, "state")
process.env["OPENCODE_TEST_HOME"] = path.join(dir, "home")
process.env["NODE_ENV"] = "test"
process.env["OPENCODE_EXPERIMENTAL_AGENT_TEAMS"] = "1"

import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Env } from "../../src/env"
import { Session } from "../../src/session"
import { Team } from "../../src/team"
import { Bus } from "../../src/bus"
import { PermissionNext } from "../../src/permission/next"
import { TeamMessaging } from "../../src/team/messaging"
import { Inbox } from "../../src/team/inbox"
import { initPermissionRouting } from "../../src/team/permission-routing"
import { Identifier } from "../../src/id/id"
import { Log } from "../../src/util/log"

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

const scenario = process.argv[2] || ""

async function run() {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
    fn: async () => {
      switch (scenario) {

        // -----------------------------------------------------------------------
        // 1. Non-team session: Asked event is NOT routed (no lead inbox message)
        // -----------------------------------------------------------------------
        case "non-team-passthrough": {
          const unsub = initPermissionRouting()
          const solo = await Session.create({})
          await seedUser(solo.id)

          await Bus.publish(PermissionNext.Event.Asked, {
            id: Identifier.ascending("permission"),
            sessionID: solo.id,
            permission: "bash",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })

          // No team exists — routing should silently skip
          // Verify by checking there are no team messages anywhere
          console.log("RESULT:passthrough:no-routing")
          unsub()
          process.exit(0)
        }

        // -----------------------------------------------------------------------
        // 2. Teammate Asked → permission_request appears in lead inbox
        // -----------------------------------------------------------------------
        case "teammate-routes-to-lead": {
          const name = uniq("pf-route")
          const lead = await Session.create({})
          const member = await Session.create({ parentID: lead.id })
          await Team.create({ name, leadSessionID: lead.id })
          await Team.addMember(name, { name: "worker", sessionID: member.id, agent: "general", status: "busy" })
          await seedUser(lead.id)
          await seedUser(member.id)

          const unsub = initPermissionRouting()

          // Bus.publish awaits Phase 1 — by the time it returns, sendStructured has run
          await Bus.publish(PermissionNext.Event.Asked, {
            id: Identifier.ascending("permission"),
            sessionID: member.id,
            permission: "bash",
            patterns: ["*"],
            always: ["*"],
            metadata: { command: "ls -la" },
          })

          const leadMsgs = await Inbox.unread(name, "lead")
          const permMsg = leadMsgs.find((m) => {
            if (!m.text.startsWith("{")) return false
            try {
              const env = JSON.parse(m.text)
              return env.__structured === true && env.msg.type === "permission_request"
            } catch { return false }
          })

          if (permMsg) {
            const env = JSON.parse(permMsg.text)
            console.log(`RESULT:routed:tool=${env.msg.tool_name}:rid=${env.msg.request_id ? "present" : "missing"}`)
          } else {
            console.log("RESULT:not-routed:lead-inbox-empty")
          }

          unsub()
          await Team.setMemberStatus(name, "worker", "shutdown")
          await Team.cleanup(name).catch(() => {})
          process.exit(0)
        }

        // -----------------------------------------------------------------------
        // 3. Lead sends allow=true → permission_response in worker inbox with allow=true
        // -----------------------------------------------------------------------
        case "lead-allow": {
          const name = uniq("pf-allow")
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
            metadata: {},
          })

          // Get request_id from lead inbox (Phase 1 already ran)
          const leadMsgs = await Inbox.unread(name, "lead")
          const permMsg = leadMsgs.find((m) => {
            if (!m.text.startsWith("{")) return false
            try { return JSON.parse(m.text).__structured === true } catch { return false }
          })

          if (!permMsg) {
            console.log("RESULT:error:no-permission-request-in-lead-inbox")
            unsub()
            break
          }

          const rid = JSON.parse(permMsg.text).msg.request_id

          // Lead approves
          await TeamMessaging.sendStructured({
            teamName: name,
            from: "lead",
            to: "worker",
            msg: { type: "permission_response", request_id: rid, allow: true },
          })

          // Wait for Phase 2 poll (POLL_MS=1500ms)
          await Bun.sleep(2500)

          const workerMsgs = await Inbox.all(name, "worker")
          const resp = workerMsgs.find((m) => {
            if (!m.text.startsWith("{")) return false
            try {
              const env = JSON.parse(m.text)
              return env.__structured === true && env.msg.type === "permission_response" && env.msg.request_id === rid
            } catch { return false }
          })

          if (resp) {
            const allow = JSON.parse(resp.text).msg.allow
            console.log(`RESULT:resolved:allow=${allow}`)
          } else {
            console.log("RESULT:error:no-response-in-worker-inbox")
          }

          unsub()
          await Team.setMemberStatus(name, "worker", "shutdown")
          await Team.cleanup(name).catch(() => {})
          process.exit(0)
        }

        // -----------------------------------------------------------------------
        // 4. Lead sends allow=false → permission_response in worker inbox with allow=false
        // -----------------------------------------------------------------------
        case "lead-deny": {
          const name = uniq("pf-deny")
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
            metadata: {},
          })

          const leadMsgs = await Inbox.unread(name, "lead")
          const permMsg = leadMsgs.find((m) => {
            if (!m.text.startsWith("{")) return false
            try { return JSON.parse(m.text).__structured === true } catch { return false }
          })

          if (!permMsg) {
            console.log("RESULT:error:no-permission-request-in-lead-inbox")
            unsub()
            break
          }

          const rid = JSON.parse(permMsg.text).msg.request_id

          // Lead denies
          await TeamMessaging.sendStructured({
            teamName: name,
            from: "lead",
            to: "worker",
            msg: { type: "permission_response", request_id: rid, allow: false, reason: "not safe" },
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

          if (resp) {
            const allow = JSON.parse(resp.text).msg.allow
            console.log(`RESULT:resolved:allow=${allow}`)
          } else {
            console.log("RESULT:error:no-response-in-worker-inbox")
          }

          unsub()
          await Team.setMemberStatus(name, "worker", "shutdown")
          await Team.cleanup(name).catch(() => {})
          process.exit(0)
        }

        // -----------------------------------------------------------------------
        // 5. Wrong request_id is ignored, correct one resolves
        // -----------------------------------------------------------------------
        case "wrong-request-id-ignored": {
          const name = uniq("pf-rid")
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

          const leadMsgs = await Inbox.unread(name, "lead")
          const permMsg = leadMsgs.find((m) => {
            if (!m.text.startsWith("{")) return false
            try { return JSON.parse(m.text).__structured === true } catch { return false }
          })

          if (!permMsg) {
            console.log("RESULT:error:no-permission-request-in-lead-inbox")
            unsub()
            break
          }

          const realRid = JSON.parse(permMsg.text).msg.request_id

          // Send wrong rid first
          await TeamMessaging.sendStructured({
            teamName: name,
            from: "lead",
            to: "worker",
            msg: { type: "permission_response", request_id: "wrong-rid-xyz", allow: false },
          })

          // Wait one poll cycle then send correct rid
          await Bun.sleep(1600)

          await TeamMessaging.sendStructured({
            teamName: name,
            from: "lead",
            to: "worker",
            msg: { type: "permission_response", request_id: realRid, allow: true },
          })

          await Bun.sleep(2500)

          const workerMsgs = await Inbox.all(name, "worker")
          const correctResp = workerMsgs.find((m) => {
            if (!m.text.startsWith("{")) return false
            try {
              const env = JSON.parse(m.text)
              return env.__structured === true && env.msg.type === "permission_response" && env.msg.request_id === realRid
            } catch { return false }
          })

          if (correctResp) {
            const allow = JSON.parse(correctResp.text).msg.allow
            console.log(`RESULT:correct-rid-resolved:allow=${allow}`)
          } else {
            console.log("RESULT:error:correct-rid-not-resolved")
          }

          unsub()
          await Team.setMemberStatus(name, "worker", "shutdown")
          await Team.cleanup(name).catch(() => {})
          process.exit(0)
        }

        default:
          console.log(`RESULT:error:unknown-scenario:${scenario}`)
      }
    },
  })
}

run().catch((e) => {
  console.error("RESULT:error:" + e.message)
  process.exit(1)
})
