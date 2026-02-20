import { Config } from "@/config/config"
import { Hono } from "hono"
import z from "zod"
import { requireAnthropicHeaders } from "./auth"
import { anthropicError } from "./error"
import { CompatTimeoutError, executeCompat, startCompat } from "./pipeline"
import { resolveModel } from "./model"
import { anthropicMessageSessionStream } from "./stream"
import { parseJSONBody } from "./request"
import { emitAuthDecision } from "../auth-observability"

const MESSAGE_MAX = 128
const BLOCK_MAX = 128
const CONTENT_MAX = 20_000
const DEFAULT_MAX_OUTPUT_TOKENS = 32_000

const contentBlock = z
  .object({
    type: z.string(),
    text: z.string().max(CONTENT_MAX).optional(),
  })
  .passthrough()

const messagesRequest = z.object({
  model: z.string().min(1),
  max_tokens: z.number().int().positive(),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.union([z.string().max(CONTENT_MAX), z.array(contentBlock).max(BLOCK_MAX)]),
      }),
    )
    .min(1)
    .max(MESSAGE_MAX),
  system: z.union([z.string().max(CONTENT_MAX), z.array(contentBlock).max(BLOCK_MAX)]).optional(),
  stream: z.boolean().optional(),
})

const countTokensRequest = z.object({
  model: z.string().min(1),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.union([z.string().max(CONTENT_MAX), z.array(contentBlock).max(BLOCK_MAX)]),
      }),
    )
    .min(1)
    .max(MESSAGE_MAX),
})

async function enabled() {
  return (await Config.get()).server?.compat?.anthropic?.enabled === true
}

async function limit() {
  const compat = (await Config.get()).server?.compat
  return compat?.anthropic?.max_output_tokens ?? compat?.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS
}

function countTokens(input: z.infer<typeof countTokensRequest>) {
  return normalizeMessages(input.messages)
    .map((item) => item.content)
    .join(" ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length
}

function blockText(block: unknown): string {
  if (!block || typeof block !== "object") return ""
  const body = block as Record<string, unknown>
  const type = body.type
  if (type !== "text") return ""
  const text = body.text
  return typeof text === "string" ? text : ""
}

function contentText(content: string | unknown[]) {
  if (typeof content === "string") return content
  return content
    .map((item) => {
      const text = blockText(item)
      if (text) return text
      if (!item || typeof item !== "object") return ""
      const block = item as Record<string, unknown>
      const type = typeof block.type === "string" ? block.type : "unknown"
      return `[${type}] ${JSON.stringify(block)}`
    })
    .filter(Boolean)
    .join("\n")
}

function normalizeMessages(messages: z.infer<typeof messagesRequest>["messages"]) {
  return messages.map((item) => ({
    role: item.role,
    content: contentText(item.content),
  }))
}

function normalizeSystem(system: z.infer<typeof messagesRequest>["system"]) {
  if (!system) return [] as Array<{ role: string; content: string }>
  if (typeof system === "string") {
    return [
      {
        role: "system",
        content: system,
      },
    ]
  }
  const text = system.map(blockText).filter(Boolean).join("\n")
  if (!text) return []
  return [
    {
      role: "system",
      content: text,
    },
  ]
}

export function AnthropicCompatRoutes() {
  return new Hono()
    .post("/v1/messages", async (c) => {
      if (!(await enabled())) return new Response("Not Found", { status: 404 })
      const auth = requireAnthropicHeaders(c.req.raw)
      if (typeof auth !== "string") {
        emitAuthDecision({
          source: "compat",
          surface: "anthropic",
          route: "anthropic.compat",
          policyMode: "strategies",
          outcome: "deny",
          strategy: "none",
          reason: "invalid_api_key",
        })
        return auth
      }
      emitAuthDecision({
        source: "compat",
        surface: "anthropic",
        route: "anthropic.compat",
        policyMode: "strategies",
        outcome: "allow",
        strategy: "api-key",
        reason: "none",
      })

      const body = await parseJSONBody(c.req.raw, "anthropic").catch(() => undefined)
      if (!body?.ok) return body?.response ?? anthropicError("bad_request", "Invalid request")
      const parsed = messagesRequest.safeParse(body.json)
      if (!parsed.success) return anthropicError("bad_request", "Invalid request")
      const maxOutputTokens = await limit()
      if (parsed.data.max_tokens > maxOutputTokens) {
        return anthropicError("bad_request", `max_tokens must be less than or equal to ${maxOutputTokens}`)
      }
      const model = await resolveModel("anthropic", parsed.data.model).catch(() => undefined)
      if (!model) return anthropicError("unknown_model", `Model '${parsed.data.model}' not found.`)
      const input = [...normalizeSystem(parsed.data.system), ...normalizeMessages(parsed.data.messages)]
      if (parsed.data.stream) {
        const started = await startCompat({
          provider: "anthropic",
          model: model.publicModel,
          resolvedModel: model.resolvedModel,
          stream: true,
          maxOutputTokens: parsed.data.max_tokens,
          input,
        }).catch(() => undefined)
        if (!started) return anthropicError("api_error", "Failed to start streaming session")
        return anthropicMessageSessionStream({
          sessionID: started.sessionID,
          model: started.model,
          pending: started.pending,
          maxOutputTokens: parsed.data.max_tokens,
          signal: c.req.raw.signal,
        })
      }
      const result = await executeCompat({
        provider: "anthropic",
        model: model.publicModel,
        resolvedModel: model.resolvedModel,
        stream: false,
        maxOutputTokens: parsed.data.max_tokens,
        input,
      }).catch((error) => (error instanceof CompatTimeoutError ? "timeout" : undefined))
      if (result === "timeout") return anthropicError("upstream_timeout", "Request timed out")
      if (!result) return anthropicError("api_error", "Execution failed")
      return c.json({
        id: result.id,
        type: "message",
        role: "assistant",
        model: result.model,
        content: result.output.map((item) =>
          item.type === "text"
            ? {
                type: "text",
                text: item.text,
              }
            : {
                type: "tool_use",
                id: item.id,
                name: item.name,
                input: item.input,
              },
        ),
        stop_reason:
          result.stopReason === "max_tokens"
            ? "max_tokens"
            : result.stopReason === "tool_use"
              ? "tool_use"
              : result.stopReason === "error"
                ? "error"
                : "end_turn",
        usage: {
          input_tokens: result.usage.inputTokens,
          output_tokens: result.usage.outputTokens,
        },
      })
    })
    .post("/v1/messages/count_tokens", async (c) => {
      if (!(await enabled())) return new Response("Not Found", { status: 404 })
      const auth = requireAnthropicHeaders(c.req.raw)
      if (typeof auth !== "string") {
        emitAuthDecision({
          source: "compat",
          surface: "anthropic",
          route: "anthropic.compat",
          policyMode: "strategies",
          outcome: "deny",
          strategy: "none",
          reason: "invalid_api_key",
        })
        return auth
      }
      emitAuthDecision({
        source: "compat",
        surface: "anthropic",
        route: "anthropic.compat",
        policyMode: "strategies",
        outcome: "allow",
        strategy: "api-key",
        reason: "none",
      })

      const body = await parseJSONBody(c.req.raw, "anthropic").catch(() => undefined)
      if (!body?.ok) return body?.response ?? anthropicError("bad_request", "Invalid request")
      const parsed = countTokensRequest.safeParse(body.json)
      if (!parsed.success) return anthropicError("bad_request", "Invalid request")
      const model = await resolveModel("anthropic", parsed.data.model).catch(() => undefined)
      if (!model) return anthropicError("unknown_model", `Model '${parsed.data.model}' not found.`)

      return c.json({
        input_tokens: countTokens(parsed.data),
      })
    })
}
