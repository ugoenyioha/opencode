import { Hono } from "hono"
import { z } from "zod"
import { Team, TeamTasks, WRITE_TOOLS } from "@/team"
import { Session } from "@/session"
import { lazy } from "../../util/lazy"

const DelegateBody = z.object({ enabled: z.boolean() })

export const TeamRoutes = lazy(() =>
  new Hono()
    .get("/", async (c) => {
      const teams = await Team.list()
      return c.json(teams)
    })
    .get("/:name", async (c) => {
      const name = c.req.param("name")
      const team = await Team.get(name)
      if (!team) return c.json({ error: "Team not found" }, 404)
      return c.json(team)
    })
    .get("/:name/tasks", async (c) => {
      const name = c.req.param("name")
      const tasks = await TeamTasks.list(name)
      return c.json(tasks)
    })
    .get("/by-session/:sessionID", async (c) => {
      const sessionID = c.req.param("sessionID")
      const result = await Team.findBySession(sessionID)
      if (!result) return c.json(null)
      const team = result.team
      const tasks = await TeamTasks.list(team.name)
      return c.json({
        team,
        tasks,
        role: result.role,
        memberName: result.memberName,
      })
    })
    .post("/:name/delegate", async (c) => {
      const name = c.req.param("name")
      const raw = await c.req.json()
      const parsed = DelegateBody.safeParse(raw)
      if (!parsed.success) return c.json({ error: "Invalid body: enabled (boolean) is required" }, 400)
      const body = parsed.data
      const team = await Team.get(name)
      if (!team) return c.json({ error: "Team not found" }, 404)

      // Toggle delegate mode: add or remove write tool denials on the lead session
      await Session.update(team.leadSessionID, (draft) => {
        if (body.enabled) {
          // Add deny rules for write tools
          const existing = draft.permission ?? []
          const newRules = WRITE_TOOLS.filter(
            (tool) => !existing.some((r) => r.permission === tool && r.action === "deny"),
          ).map((tool) => ({ permission: tool, pattern: "*", action: "deny" as const }))
          draft.permission = [...existing, ...newRules]
        } else {
          // Remove deny rules for write tools
          draft.permission = (draft.permission ?? []).filter(
            (rule) => !((WRITE_TOOLS as readonly string[]).includes(rule.permission) && rule.action === "deny"),
          )
        }
      })

      // Update team config
      await Team.setDelegate(name, body.enabled)

      return c.json({ ok: true, delegate: body.enabled })
    }),
)
