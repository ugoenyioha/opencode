import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { TaskManager, TaskInfoSchema } from "@/task"
import { migrateToBackground, listForegroundProcesses } from "@/tool/bash"
import { errors } from "../error"
import { lazy } from "../../util/lazy"

export const TaskRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List background tasks",
        operationId: "task.list",
        responses: {
          200: {
            description: "List of background tasks",
            content: {
              "application/json": {
                schema: resolver(TaskInfoSchema.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(TaskManager.list())
      },
    )
    .get(
      "/foreground",
      describeRoute({
        summary: "List foreground bash processes that can be backgrounded",
        operationId: "task.foreground",
        responses: {
          200: {
            description: "List of foreground processes",
            content: {
              "application/json": {
                schema: resolver(
                  z.array(
                    z.object({
                      callID: z.string(),
                      sessionID: z.string(),
                      pid: z.number(),
                      command: z.string(),
                      description: z.string(),
                      startTime: z.number(),
                    }),
                  ),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const procs = listForegroundProcesses().map((p) => ({
          callID: p.callID,
          sessionID: p.sessionID,
          pid: p.pid,
          command: p.command,
          description: p.description,
          startTime: p.startTime,
        }))
        return c.json(procs)
      },
    )
    .post(
      "/migrate/:callId",
      describeRoute({
        summary: "Migrate a foreground bash process to a background task",
        operationId: "task.migrate",
        responses: {
          200: {
            description: "Migration result",
            content: {
              "application/json": {
                schema: resolver(z.object({ taskId: z.string() })),
              },
            },
          },
          ...errors(404),
        },
      }),
      async (c) => {
        const callId = c.req.param("callId")
        const foreground = listForegroundProcesses()
        if (foreground.length === 0) {
          return c.json({ error: `No foreground processes. callId=${callId}` }, 404)
        }
        const taskId = await migrateToBackground(callId)
        if (!taskId) {
          const ids = foreground.map((p) => p.callID).join(", ")
          return c.json({ error: `Process not found for callId=${callId}. Active: [${ids}]` }, 404)
        }
        return c.json({ taskId })
      },
    )
    .get(
      "/:taskId",
      describeRoute({
        summary: "Get background task",
        operationId: "task.get",
        responses: {
          200: {
            description: "Task info",
            content: {
              "application/json": {
                schema: resolver(TaskInfoSchema),
              },
            },
          },
          ...errors(404),
        },
      }),
      async (c) => {
        const task = TaskManager.get(c.req.param("taskId"))
        if (!task) return c.json({ error: "Task not found" }, 404)
        return c.json(task)
      },
    )
    .get(
      "/:taskId/output",
      describeRoute({
        summary: "Read task output",
        operationId: "task.output",
        responses: {
          200: {
            description: "Task output",
            content: {
              "application/json": {
                schema: resolver(z.object({ output: z.string() })),
              },
            },
          },
          ...errors(404),
        },
      }),
      async (c) => {
        const output = TaskManager.read(c.req.param("taskId"))
        if (output === undefined) return c.json({ error: "Task not found" }, 404)
        return c.json({ output })
      },
    )
    .get(
      "/:taskId/tail",
      describeRoute({
        summary: "Read last N lines of task output",
        operationId: "task.tail",
        responses: {
          200: {
            description: "Task output tail",
            content: {
              "application/json": {
                schema: resolver(z.object({ output: z.string() })),
              },
            },
          },
          ...errors(404),
        },
      }),
      async (c) => {
        const lines = Math.max(1, Math.min(10000, parseInt(c.req.query("lines") ?? "50", 10) || 50))
        const output = TaskManager.tail(c.req.param("taskId"), lines)
        if (output === undefined) return c.json({ error: "Task not found" }, 404)
        return c.json({ output })
      },
    )
    .post(
      "/:taskId/kill",
      describeRoute({
        summary: "Kill a running task",
        operationId: "task.kill",
        responses: {
          200: {
            description: "Task killed",
            content: {
              "application/json": {
                schema: resolver(z.object({ ok: z.boolean() })),
              },
            },
          },
          ...errors(404),
        },
      }),
      async (c) => {
        const ok = await TaskManager.kill(c.req.param("taskId"))
        if (!ok) return c.json({ error: "Task not found or not running" }, 404)
        return c.json({ ok: true })
      },
    )
    .delete(
      "/:taskId",
      describeRoute({
        summary: "Remove a completed task",
        operationId: "task.remove",
        responses: {
          200: {
            description: "Task removed",
            content: {
              "application/json": {
                schema: resolver(z.object({ ok: z.boolean() })),
              },
            },
          },
          ...errors(404),
        },
      }),
      async (c) => {
        const ok = TaskManager.remove(c.req.param("taskId"))
        if (!ok) return c.json({ error: "Task not found or still running" }, 404)
        return c.json({ ok: true })
      },
    ),
)
