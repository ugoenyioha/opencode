import { Hono } from "hono"
import z from "zod"
import { describeRoute, validator, resolver } from "hono-openapi"
import { Team, TeamTasks, TeamInfoSchema, TeamTaskSchema, WRITE_TOOLS } from "@/team"
import { TeamMessaging } from "@/team/messaging"
import { Inbox } from "@/team/inbox"
import { TeamMemberSchema } from "@/team/events"
import { Session } from "@/session"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { Identifier } from "@/id/id"
import { lazy } from "../../util/lazy"
import { errors } from "../error"

const Delegate = z.object({ enabled: z.boolean() })
const TeamMember = TeamMemberSchema.meta({ ref: "TeamMember" })
const TeamInfo = TeamInfoSchema.meta({ ref: "TeamInfo" })
const TeamTask = TeamTaskSchema.meta({ ref: "TeamTask" })
const TeamBySession = z
  .object({
    team: TeamInfo,
    tasks: TeamTask.array(),
    role: z.enum(["lead", "member"]),
    memberName: z.string().optional(),
  })
  .meta({ ref: "TeamBySession" })
const TeamModel = z.object({ providerID: z.string(), modelID: z.string() }).meta({ ref: "TeamModel" })
const TeamSpawnBody = z
  .object({
    leadSessionID: Identifier.schema("session"),
    name: TeamMember.shape.name,
    agent: z.string(),
    model: TeamModel.optional(),
    prompt: z.string(),
    claimTask: z.string().optional(),
    requirePlanApproval: z.boolean().optional(),
  })
  .meta({ ref: "TeamSpawnRequest" })
const TeamMessageBody = z
  .object({
    sessionID: Identifier.schema("session"),
    to: z.string(),
    text: z.string(),
  })
  .meta({ ref: "TeamMessageRequest" })
const TeamShutdownBody = z
  .object({
    leadSessionID: Identifier.schema("session"),
    member: z.string(),
  })
  .meta({ ref: "TeamShutdownRequest" })
const TeamCleanupBody = z
  .object({
    leadSessionID: Identifier.schema("session"),
  })
  .meta({ ref: "TeamCleanupRequest" })
const TeamApprovePlanBody = z
  .object({
    leadSessionID: Identifier.schema("session"),
    member: z.string(),
    approved: z.boolean(),
    feedback: z.string().optional(),
  })
  .meta({ ref: "TeamApprovePlanRequest" })
const TeamMessagesQuery = z
  .object({
    sessionID: Identifier.schema("session"),
    unread: z.coerce.boolean().optional(),
  })
  .meta({ ref: "TeamMessagesQuery" })
const TeamMessageItem = z
  .object({
    id: z.string(),
    from: z.string(),
    text: z.string(),
    timestamp: z.number(),
    read: z.boolean(),
  })
  .meta({ ref: "TeamMessageItem" })
const Ok = z.object({ ok: z.literal(true) }).meta({ ref: "TeamOk" })
const Spawned = z.object({ sessionID: Identifier.schema("session") }).meta({ ref: "TeamSpawned" })

async function lead(sessionID: string, name: string) {
  const info = await Team.findBySession(sessionID)
  if (!info || info.role !== "lead" || info.team.name !== name) return
  return info
}

async function model(body: z.infer<typeof TeamSpawnBody>, agent: { model?: { providerID: string; modelID: string } }) {
  if (body.model) {
    await Provider.getModel(body.model.providerID, body.model.modelID)
    return body.model
  }
  if (agent.model) return agent.model
  const msgs = await Session.messages({ sessionID: body.leadSessionID })
  for (let i = msgs.length - 1; i >= 0; i--) {
    const info = msgs[i].info
    if (info.role !== "user") continue
    if (!("model" in info)) continue
    return info.model
  }
  return await Provider.defaultModel()
}

/**
 * HTTP API routes for the Agent Teams subsystem.
 * All mutating endpoints require the caller to be the team lead (verified via session ID).
 */
export const TeamRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List teams",
        description: "List all teams in this project.",
        operationId: "team.list",
        responses: {
          200: {
            description: "List of teams",
            content: { "application/json": { schema: resolver(TeamInfo.array()) } },
          },
        },
      }),
      async (c) => {
        return c.json(await Team.list())
      },
    )
    .get(
      "/:name",
      describeRoute({
        summary: "Get team",
        description: "Retrieve a team by name.",
        operationId: "team.get",
        responses: {
          200: {
            description: "Team info",
            content: { "application/json": { schema: resolver(TeamInfo) } },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ name: z.string() })),
      async (c) => {
        const team = await Team.get(c.req.valid("param").name)
        if (!team) return c.json({ error: "Team not found" }, 404)
        return c.json(team)
      },
    )
    .get(
      "/:name/tasks",
      describeRoute({
        summary: "List team tasks",
        description: "List all tasks for a team.",
        operationId: "team.tasks.list",
        responses: {
          200: {
            description: "List of tasks",
            content: { "application/json": { schema: resolver(TeamTask.array()) } },
          },
        },
      }),
      validator("param", z.object({ name: z.string() })),
      async (c) => {
        return c.json(await TeamTasks.list(c.req.valid("param").name))
      },
    )
    .get(
      "/by-session/:sessionID",
      describeRoute({
        summary: "Find team by session",
        description: "Find the team a session belongs to.",
        operationId: "team.bySession",
        responses: {
          200: {
            description: "Team info with role and tasks",
            content: { "application/json": { schema: resolver(TeamBySession.nullable()) } },
          },
        },
      }),
      validator("param", z.object({ sessionID: Identifier.schema("session") })),
      async (c) => {
        const result = await Team.findBySession(c.req.valid("param").sessionID)
        if (!result) return c.json(null)
        return c.json({
          team: result.team,
          tasks: await TeamTasks.list(result.team.name),
          role: result.role,
          memberName: result.memberName,
        })
      },
    )
    .post(
      "/:name/delegate",
      describeRoute({
        summary: "Toggle delegate mode",
        description: "Enable or disable delegate mode for a team.",
        operationId: "team.delegate",
        responses: {
          200: { description: "Delegate mode updated" },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ name: z.string() })),
      validator("json", Delegate.extend({ leadSessionID: Identifier.schema("session").optional() })),
      async (c) => {
        const { name } = c.req.valid("param")
        const { enabled, leadSessionID } = c.req.valid("json")
        const team = await Team.get(name)
        if (!team) return c.json({ error: "Team not found" }, 404)
        if (!team.leadSessionID) return c.json({ error: "Team has no lead session" }, 400)
        // Verify caller is the lead when a session ID is provided
        if (leadSessionID) {
          const auth = await lead(leadSessionID, name)
          if (!auth) return c.json({ error: "Unauthorized: not the team lead" }, 403)
        }

        const info = await Session.get(team.leadSessionID)
        await Session.setPermission({
          sessionID: team.leadSessionID,
          permission: enabled
            ? [
                ...(info.permission ?? []),
                ...WRITE_TOOLS.filter(
                  (tool) => !(info.permission ?? []).some((r) => r.permission === tool && r.action === "deny"),
                ).map((tool) => ({ permission: tool, pattern: "*", action: "deny" as const })),
              ]
            : (info.permission ?? []).filter(
                (rule) => !((WRITE_TOOLS as readonly string[]).includes(rule.permission) && rule.action === "deny"),
              ),
        })

        await Team.setDelegate(name, enabled)
        return c.json({ ok: true, delegate: enabled })
      },
    )
    .post(
      "/:name/spawn",
      describeRoute({
        summary: "Spawn teammate",
        description: "Spawn a teammate as the team lead.",
        operationId: "team.spawn",
        responses: {
          201: {
            description: "Spawned teammate session",
            content: { "application/json": { schema: resolver(Spawned) } },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ name: z.string() })),
      validator("json", TeamSpawnBody),
      async (c) => {
        const { name } = c.req.valid("param")
        const body = c.req.valid("json")
        const auth = await lead(body.leadSessionID, name)
        if (!auth) return c.json({ error: "Unauthorized: not the team lead" }, 403)
        if (body.name === "lead") return c.json({ error: 'Name "lead" is reserved' }, 400)

        const agent = await Agent.get(body.agent)
        if (!agent) return c.json({ error: `Agent "${body.agent}" not found` }, 400)

        try {
          const spawned = await Team.spawnMember({
            teamName: name,
            name: body.name,
            parentSessionID: body.leadSessionID,
            agent,
            model: await model(body, agent),
            prompt: body.prompt,
            claimTask: body.claimTask,
            planApproval: !!body.requirePlanApproval,
          })
          return c.json({ sessionID: spawned.sessionID }, 201)
        } catch (err) {
          return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
        }
      },
    )
    .post(
      "/:name/message",
      describeRoute({
        summary: "Send team message",
        description: "Send a direct message between team participants.",
        operationId: "team.message",
        responses: {
          200: {
            description: "Message sent",
            content: { "application/json": { schema: resolver(Ok) } },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ name: z.string() })),
      validator("json", TeamMessageBody),
      async (c) => {
        const { name } = c.req.valid("param")
        const body = c.req.valid("json")
        const info = await Team.findBySession(body.sessionID)
        if (!info || info.team.name !== name) return c.json({ error: "Unauthorized: not in this team" }, 403)
        const from = info.role === "lead" ? "lead" : info.memberName
        if (!from) return c.json({ error: "Unauthorized: sender not found" }, 403)

        try {
          await TeamMessaging.send({
            teamName: name,
            from,
            to: body.to,
            text: body.text,
          })
          return c.json({ ok: true })
        } catch (err) {
          return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
        }
      },
    )
    .post(
      "/:name/shutdown",
      describeRoute({
        summary: "Request teammate shutdown",
        description: "Request a teammate to shut down.",
        operationId: "team.shutdown",
        responses: {
          200: {
            description: "Shutdown requested",
            content: { "application/json": { schema: resolver(Ok) } },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ name: z.string() })),
      validator("json", TeamShutdownBody),
      async (c) => {
        const { name } = c.req.valid("param")
        const body = c.req.valid("json")
        const auth = await lead(body.leadSessionID, name)
        if (!auth) return c.json({ error: "Unauthorized: not the team lead" }, 403)

        const ok = await Team.transitionMemberStatus(name, body.member, "shutdown_requested")
        if (!ok) return c.json({ error: "Failed to request shutdown" }, 400)
        return c.json({ ok: true })
      },
    )
    .post(
      "/:name/cleanup",
      describeRoute({
        summary: "Cleanup team",
        description: "Clean up team resources once members are shut down.",
        operationId: "team.cleanup",
        responses: {
          200: {
            description: "Team cleaned up",
            content: { "application/json": { schema: resolver(Ok) } },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ name: z.string() })),
      validator("json", TeamCleanupBody),
      async (c) => {
        const { name } = c.req.valid("param")
        const body = c.req.valid("json")
        const auth = await lead(body.leadSessionID, name)
        if (!auth) return c.json({ error: "Unauthorized: not the team lead" }, 403)

        try {
          await Team.cleanup(name)
          return c.json({ ok: true })
        } catch (err) {
          return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
        }
      },
    )
    .post(
      "/:name/approve-plan",
      describeRoute({
        summary: "Approve teammate plan",
        description: "Approve or reject a teammate implementation plan.",
        operationId: "team.approvePlan",
        responses: {
          200: {
            description: "Plan decision saved",
            content: { "application/json": { schema: resolver(Ok) } },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ name: z.string() })),
      validator("json", TeamApprovePlanBody),
      async (c) => {
        const { name } = c.req.valid("param")
        const body = c.req.valid("json")
        const auth = await lead(body.leadSessionID, name)
        if (!auth) return c.json({ error: "Unauthorized: not the team lead" }, 403)

        try {
          await Team.approvePlan({
            teamName: name,
            memberName: body.member,
            approved: body.approved,
            feedback: body.feedback,
          })
          return c.json({ ok: true })
        } catch (err) {
          return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
        }
      },
    )
    .get(
      "/:name/messages",
      describeRoute({
        summary: "List team messages",
        description: "List inbox messages for a team session.",
        operationId: "team.messages",
        responses: {
          200: {
            description: "Inbox messages",
            content: { "application/json": { schema: resolver(TeamMessageItem.array()) } },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ name: z.string() })),
      validator("query", TeamMessagesQuery),
      async (c) => {
        const { name } = c.req.valid("param")
        const query = c.req.valid("query")
        const info = await Team.findBySession(query.sessionID)
        if (!info || info.team.name !== name) return c.json({ error: "Unauthorized: not in this team" }, 403)
        const member = info.role === "lead" ? "lead" : info.memberName
        if (!member) return c.json([])
        if (query.unread) return c.json(await Inbox.unread(name, member))
        return c.json(await Inbox.all(name, member))
      },
    )
    .post(
      "/:name/cancel",
      describeRoute({
        summary: "Cancel teammates",
        description:
          "Cancel active teammates' prompt loops. " + "Pass { member: name } to cancel one, or omit to cancel all.",
        operationId: "team.cancel",
        responses: {
          200: { description: "Number of cancelled members" },
          ...errors(404),
        },
      }),
      validator("param", z.object({ name: z.string() })),
      validator(
        "json",
        z.object({ leadSessionID: Identifier.schema("session").optional(), member: z.string().optional() }),
      ),
      async (c) => {
        const { name } = c.req.valid("param")
        const { leadSessionID, member } = c.req.valid("json")
        // Require lead authorization when a session ID is provided
        if (leadSessionID) {
          const auth = await lead(leadSessionID, name)
          if (!auth) return c.json({ error: "Unauthorized: not the team lead" }, 403)
        } else {
          // Fallback: verify team exists (backwards-compatible for TUI cancel)
          const team = await Team.get(name)
          if (!team) return c.json({ error: "Team not found" }, 404)
        }

        if (member) {
          const ok = await Team.cancelMember(name, member)
          return c.json({ ok, cancelled: ok ? 1 : 0 })
        }
        const cancelled = await Team.cancelAllMembers(name)
        return c.json({ ok: true, cancelled })
      },
    ),
)
