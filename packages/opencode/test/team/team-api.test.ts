import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Team, TeamTasks } from "../../src/team"
import { Session } from "../../src/session"
import { Env } from "../../src/env"
import { Log } from "../../src/util/log"
import { Identifier } from "../../src/id/id"
import { Server } from "../../src/server/server"
import { TeamMessaging } from "../../src/team/messaging"

Log.init({ print: false })

const projectRoot = path.join(__dirname, "../..")

let counter = 0
function uniqueName(base: string) {
  return `${base}-${Date.now()}-${++counter}`
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
}

function json(body: Record<string, unknown>) {
  return {
    method: "POST" as const,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }
}

// ---------------------------------------------------------------------------
// POST /:name/spawn
// ---------------------------------------------------------------------------
describe("POST /team/:name/spawn", () => {
  test("returns 403 when caller is not the team lead", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const name = uniqueName("spawn-auth")
        const lead = await Session.create({})
        await Team.create({ name, leadSessionID: lead.id })

        const stranger = await Session.create({})
        const app = Server.App()
        const res = await app.request(
          `/team/${name}/spawn`,
          json({
            leadSessionID: stranger.id,
            name: "worker",
            agent: "general",
            prompt: "do stuff",
          }),
        )

        expect(res.status).toBe(403)
        const body = (await res.json()) as any
        expect(body.error).toContain("Unauthorized")

        await Team.cleanup(name).catch(() => {})
      },
    })
  })

  test("returns 400 when name is 'lead'", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const name = uniqueName("spawn-reserved")
        const lead = await Session.create({})
        await Team.create({ name, leadSessionID: lead.id })
        await seedUserMessage(lead.id)

        const app = Server.App()
        const res = await app.request(
          `/team/${name}/spawn`,
          json({
            leadSessionID: lead.id,
            name: "lead",
            agent: "general",
            prompt: "do stuff",
          }),
        )

        expect(res.status).toBe(400)
        const body = (await res.json()) as any
        expect(body.error).toContain("lead")

        await Team.cleanup(name).catch(() => {})
      },
    })
  })

  test("returns 400 when agent does not exist", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const name = uniqueName("spawn-bad-agent")
        const lead = await Session.create({})
        await Team.create({ name, leadSessionID: lead.id })
        await seedUserMessage(lead.id)

        const app = Server.App()
        const res = await app.request(
          `/team/${name}/spawn`,
          json({
            leadSessionID: lead.id,
            name: "worker",
            agent: "nonexistent-agent-type-xyz",
            prompt: "do stuff",
          }),
        )

        expect(res.status).toBe(400)
        const body = (await res.json()) as any
        expect(body.error).toContain("not found")

        await Team.cleanup(name).catch(() => {})
      },
    })
  })
})

// ---------------------------------------------------------------------------
// POST /:name/message
// ---------------------------------------------------------------------------
describe("POST /team/:name/message", () => {
  test("returns 403 when caller is not a team member", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const name = uniqueName("msg-auth")
        const lead = await Session.create({})
        await Team.create({ name, leadSessionID: lead.id })

        const stranger = await Session.create({})
        const app = Server.App()
        const res = await app.request(
          `/team/${name}/message`,
          json({
            sessionID: stranger.id,
            to: "lead",
            text: "hello",
          }),
        )

        expect(res.status).toBe(403)
        const body = (await res.json()) as any
        expect(body.error).toContain("Unauthorized")

        await Team.cleanup(name).catch(() => {})
      },
    })
  })

  test("lead can send a message to a member", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const name = uniqueName("msg-send")
        const lead = await Session.create({})
        await Team.create({ name, leadSessionID: lead.id })
        await seedUserMessage(lead.id)

        const member = await Session.create({ parentID: lead.id })
        await Team.addMember(name, {
          name: "worker",
          sessionID: member.id,
          agent: "general",
          status: "busy",
        })
        await seedUserMessage(member.id)

        const app = Server.App()
        const res = await app.request(
          `/team/${name}/message`,
          json({
            sessionID: lead.id,
            to: "worker",
            text: "please do the task",
          }),
        )

        expect(res.status).toBe(200)
        const body = (await res.json()) as any
        expect(body.ok).toBe(true)

        // Cleanup
        await Team.setMemberStatus(name, "worker", "shutdown")
        await Team.cleanup(name).catch(() => {})
      },
    })
  })
})

// ---------------------------------------------------------------------------
// POST /:name/shutdown
// ---------------------------------------------------------------------------
describe("POST /team/:name/shutdown", () => {
  test("returns 403 when caller is not the team lead", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const name = uniqueName("shutdown-auth")
        const lead = await Session.create({})
        await Team.create({ name, leadSessionID: lead.id })

        const member = await Session.create({ parentID: lead.id })
        await Team.addMember(name, {
          name: "worker",
          sessionID: member.id,
          agent: "general",
          status: "busy",
        })

        const stranger = await Session.create({})
        const app = Server.App()
        const res = await app.request(
          `/team/${name}/shutdown`,
          json({
            leadSessionID: stranger.id,
            member: "worker",
          }),
        )

        expect(res.status).toBe(403)
        const body = (await res.json()) as any
        expect(body.error).toContain("Unauthorized")

        await Team.setMemberStatus(name, "worker", "shutdown")
        await Team.cleanup(name).catch(() => {})
      },
    })
  })

  test("lead can request a member shutdown", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const name = uniqueName("shutdown-ok")
        const lead = await Session.create({})
        await Team.create({ name, leadSessionID: lead.id })

        const member = await Session.create({ parentID: lead.id })
        await Team.addMember(name, {
          name: "worker",
          sessionID: member.id,
          agent: "general",
          status: "busy",
        })

        const app = Server.App()
        const res = await app.request(
          `/team/${name}/shutdown`,
          json({
            leadSessionID: lead.id,
            member: "worker",
          }),
        )

        expect(res.status).toBe(200)
        const body = (await res.json()) as any
        expect(body.ok).toBe(true)

        // Verify member status changed
        const team = await Team.get(name)
        const w = team!.members.find((m) => m.name === "worker")
        expect(w!.status).toBe("shutdown_requested")

        await Team.setMemberStatus(name, "worker", "shutdown")
        await Team.cleanup(name).catch(() => {})
      },
    })
  })

  test("returns 400 for non-existent member", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const name = uniqueName("shutdown-noexist")
        const lead = await Session.create({})
        await Team.create({ name, leadSessionID: lead.id })

        const app = Server.App()
        const res = await app.request(
          `/team/${name}/shutdown`,
          json({
            leadSessionID: lead.id,
            member: "ghost",
          }),
        )

        expect(res.status).toBe(400)
        const body = (await res.json()) as any
        expect(body.error).toContain("Failed")

        await Team.cleanup(name).catch(() => {})
      },
    })
  })
})

// ---------------------------------------------------------------------------
// POST /:name/cleanup
// ---------------------------------------------------------------------------
describe("POST /team/:name/cleanup", () => {
  test("returns 403 when caller is not the team lead", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const name = uniqueName("cleanup-auth")
        const lead = await Session.create({})
        await Team.create({ name, leadSessionID: lead.id })

        const stranger = await Session.create({})
        const app = Server.App()
        const res = await app.request(
          `/team/${name}/cleanup`,
          json({
            leadSessionID: stranger.id,
          }),
        )

        expect(res.status).toBe(403)
        const body = (await res.json()) as any
        expect(body.error).toContain("Unauthorized")

        await Team.cleanup(name).catch(() => {})
      },
    })
  })

  test("lead can cleanup a team with all members shutdown", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const name = uniqueName("cleanup-ok")
        const lead = await Session.create({})
        await Team.create({ name, leadSessionID: lead.id })

        const member = await Session.create({ parentID: lead.id })
        await Team.addMember(name, {
          name: "worker",
          sessionID: member.id,
          agent: "general",
          status: "busy",
        })
        await Team.setMemberStatus(name, "worker", "shutdown")

        const app = Server.App()
        const res = await app.request(
          `/team/${name}/cleanup`,
          json({
            leadSessionID: lead.id,
          }),
        )

        expect(res.status).toBe(200)
        const body = (await res.json()) as any
        expect(body.ok).toBe(true)

        // Team should be gone
        const team = await Team.get(name)
        expect(team).toBeUndefined()
      },
    })
  })

  test("returns 400 when members are still active", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const name = uniqueName("cleanup-active")
        const lead = await Session.create({})
        await Team.create({ name, leadSessionID: lead.id })

        const member = await Session.create({ parentID: lead.id })
        await Team.addMember(name, {
          name: "worker",
          sessionID: member.id,
          agent: "general",
          status: "busy",
        })

        const app = Server.App()
        const res = await app.request(
          `/team/${name}/cleanup`,
          json({
            leadSessionID: lead.id,
          }),
        )

        expect(res.status).toBe(400)
        const body = (await res.json()) as any
        expect(body.error).toContain("non-shutdown")

        await Team.setMemberStatus(name, "worker", "shutdown")
        await Team.cleanup(name).catch(() => {})
      },
    })
  })
})

// ---------------------------------------------------------------------------
// POST /:name/approve-plan
// ---------------------------------------------------------------------------
describe("POST /team/:name/approve-plan", () => {
  test("returns 403 when caller is not the team lead", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const name = uniqueName("approve-auth")
        const lead = await Session.create({})
        await Team.create({ name, leadSessionID: lead.id })

        const member = await Session.create({ parentID: lead.id })
        await Team.addMember(name, {
          name: "planner",
          sessionID: member.id,
          agent: "general",
          status: "busy",
          planApproval: "pending",
        })
        await seedUserMessage(member.id)

        const stranger = await Session.create({})
        const app = Server.App()
        const res = await app.request(
          `/team/${name}/approve-plan`,
          json({
            leadSessionID: stranger.id,
            member: "planner",
            approved: true,
          }),
        )

        expect(res.status).toBe(403)
        const body = (await res.json()) as any
        expect(body.error).toContain("Unauthorized")

        await Team.setMemberStatus(name, "planner", "shutdown")
        await Team.cleanup(name).catch(() => {})
      },
    })
  })

  test("lead can approve a member plan", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const name = uniqueName("approve-ok")
        const lead = await Session.create({})
        await Team.create({ name, leadSessionID: lead.id })
        await seedUserMessage(lead.id)

        const member = await Session.create({ parentID: lead.id })
        await Team.addMember(name, {
          name: "planner",
          sessionID: member.id,
          agent: "general",
          status: "busy",
          planApproval: "pending",
        })
        await seedUserMessage(member.id)

        const app = Server.App()
        const res = await app.request(
          `/team/${name}/approve-plan`,
          json({
            leadSessionID: lead.id,
            member: "planner",
            approved: true,
            feedback: "looks good",
          }),
        )

        expect(res.status).toBe(200)
        const body = (await res.json()) as any
        expect(body.ok).toBe(true)

        await Team.setMemberStatus(name, "planner", "shutdown")
        await Team.cleanup(name).catch(() => {})
      },
    })
  })

  test("lead can reject a member plan", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const name = uniqueName("approve-reject")
        const lead = await Session.create({})
        await Team.create({ name, leadSessionID: lead.id })
        await seedUserMessage(lead.id)

        const member = await Session.create({ parentID: lead.id })
        await Team.addMember(name, {
          name: "planner",
          sessionID: member.id,
          agent: "general",
          status: "busy",
          planApproval: "pending",
        })
        await seedUserMessage(member.id)

        const app = Server.App()
        const res = await app.request(
          `/team/${name}/approve-plan`,
          json({
            leadSessionID: lead.id,
            member: "planner",
            approved: false,
            feedback: "need more detail",
          }),
        )

        expect(res.status).toBe(200)
        const body = (await res.json()) as any
        expect(body.ok).toBe(true)

        await Team.setMemberStatus(name, "planner", "shutdown")
        await Team.cleanup(name).catch(() => {})
      },
    })
  })
})

// ---------------------------------------------------------------------------
// GET /:name/messages
// ---------------------------------------------------------------------------
describe("GET /team/:name/messages", () => {
  test("returns 403 when caller is not in the team", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const name = uniqueName("messages-auth")
        const lead = await Session.create({})
        await Team.create({ name, leadSessionID: lead.id })

        const stranger = await Session.create({})
        const app = Server.App()
        const res = await app.request(`/team/${name}/messages?sessionID=${stranger.id}`)

        expect(res.status).toBe(403)
        const body = (await res.json()) as any
        expect(body.error).toContain("Unauthorized")

        await Team.cleanup(name).catch(() => {})
      },
    })
  })

  test("returns empty array for lead with no messages", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const name = uniqueName("messages-empty")
        const lead = await Session.create({})
        await Team.create({ name, leadSessionID: lead.id })

        const app = Server.App()
        const res = await app.request(`/team/${name}/messages?sessionID=${lead.id}`)

        expect(res.status).toBe(200)
        const body = (await res.json()) as any
        expect(Array.isArray(body)).toBe(true)
        expect(body.length).toBe(0)

        await Team.cleanup(name).catch(() => {})
      },
    })
  })

  test("returns messages after a member sends one", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const name = uniqueName("messages-list")
        const lead = await Session.create({})
        await Team.create({ name, leadSessionID: lead.id })
        await seedUserMessage(lead.id)

        const member = await Session.create({ parentID: lead.id })
        await Team.addMember(name, {
          name: "reporter",
          sessionID: member.id,
          agent: "general",
          status: "busy",
        })
        await seedUserMessage(member.id)

        // Send a message from the member to lead
        await TeamMessaging.send({
          teamName: name,
          from: "reporter",
          to: "lead",
          text: "status update",
        })

        const app = Server.App()
        const res = await app.request(`/team/${name}/messages?sessionID=${lead.id}`)

        expect(res.status).toBe(200)
        const body = (await res.json()) as any
        expect(Array.isArray(body)).toBe(true)
        expect(body.length).toBeGreaterThanOrEqual(1)
        const msg = body.find((m: any) => m.text === "status update")
        expect(msg).toBeDefined()
        expect(msg.from).toBe("reporter")

        await Team.setMemberStatus(name, "reporter", "shutdown")
        await Team.cleanup(name).catch(() => {})
      },
    })
  })
})
