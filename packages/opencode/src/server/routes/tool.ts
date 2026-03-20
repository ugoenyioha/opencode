import { Identifier } from "@/id/id"
import { PermissionNext } from "@/permission/next"
import { Session } from "@/session"
import { ToolRegistry } from "@/tool/registry"
import { Tool } from "@/tool/tool"
import { lazy } from "@/util/lazy"
import { describeRoute, resolver, validator } from "hono-openapi"
import { Hono } from "hono"
import z from "zod"
import { Config } from "@/config/config"
import { Plugin } from "@/plugin"

const SENSITIVE_TOOLS = new Set([
  "bash",
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "patch",
  "apply_patch",
  "approve_action",
  "workspace_identity_update",
  "workspace_soul_update",
  "workspace_user_update",
])

export function isSensitiveTool(tool: string) {
  return SENSITIVE_TOOLS.has(tool)
}

export const ToolRoutes = lazy(() =>
  new Hono().post(
    "/:toolName",
    describeRoute({
      summary: "Execute tool",
      description: "Execute an allowlisted tool over HTTP.",
      operationId: "tool.execute",
      responses: {
        200: {
          description: "Tool execution result",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  title: z.string(),
                  output: z.string(),
                  metadata: z.record(z.string(), z.any()),
                  attachments: z
                    .array(
                      z.object({
                        type: z.literal("file"),
                        mime: z.string().optional(),
                        filename: z.string().optional(),
                        url: z.string(),
                      }),
                    )
                    .optional(),
                }),
              ),
            },
          },
        },
      },
    }),
    validator("param", z.object({ toolName: z.string().min(1) })),
    validator(
      "json",
      z.object({
        sessionID: Identifier.schema("session"),
        args: z.record(z.string(), z.unknown()).optional(),
      }),
    ),
    async (c) => {
      const config = await Config.get()
      const endpoint = config.server?.toolEndpoint
      if (!endpoint?.enabled) {
        return c.json({ error: "Tool endpoint is disabled" }, 404)
      }
      const authStrategies = Array.isArray(endpoint.auth) ? endpoint.auth : [endpoint.auth ?? "api-key"]
      if (authStrategies.includes("plugin") && !(await Plugin.hasExternal("http.request"))) {
        return c.json({ error: "Tool endpoint auth=plugin requires external plugin http.request hook" }, 503)
      }

      const toolName = c.req.valid("param").toolName
      const allowed = endpoint.allowedTools ?? []
      if (!allowed.includes(toolName)) {
        return c.json({ error: `Tool not allowed: ${toolName}` }, 403)
      }

      if (isSensitiveTool(toolName) && endpoint.allowSensitiveTools !== true) {
        return c.json({ error: `Sensitive tool requires explicit override: ${toolName}` }, 403)
      }

      const body = c.req.valid("json")
      await Session.get(body.sessionID)
      const tool = (await ToolRegistry.tools({ providerID: "", modelID: "" })).find((item) => item.id === toolName)
      if (!tool) {
        return c.json({ error: `Tool not found: ${toolName}` }, 404)
      }

      const metadata: Record<string, any> = {}
      const messages = await Session.messages({ sessionID: body.sessionID, limit: 100 })
      const result = await tool.execute((body.args ?? {}) as any, {
        sessionID: body.sessionID,
        messageID: Identifier.ascending("message"),
        callID: Identifier.ascending("part"),
        abort: c.req.raw.signal,
        extra: {},
        agent: "http",
        messages,
        metadata(input) {
          if (input.metadata) Object.assign(metadata, input.metadata)
        },
        async ask(input) {
          const ruleset = PermissionNext.fromConfig(config.permission ?? {})
          await PermissionNext.ask({
            ...input,
            ruleset,
            sessionID: body.sessionID,
          })
        },
      } satisfies Tool.Context)

      return c.json({
        ...result,
        metadata: {
          ...metadata,
          ...result.metadata,
        },
      })
    },
  ),
)
