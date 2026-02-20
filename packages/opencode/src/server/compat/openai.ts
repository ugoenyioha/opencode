import { Config } from "@/config/config"
import { Hono } from "hono"
import z from "zod"
import { requireOpenAIBearer } from "./auth"
import { openAIError } from "./error"
import { CompatTimeoutError, executeCompat, startCompat } from "./pipeline"
import { listModels, resolveModel } from "./model"
import { openAIChatSessionStream, openAIResponsesSessionStream } from "./stream"
import { parseJSONBody } from "./request"

const MESSAGE_MAX = 128
const CONTENT_MAX = 20_000
const DEFAULT_MAX_OUTPUT_TOKENS = 32_000

const openAIContentBlock = z
  .object({
    type: z.string(),
    text: z.string().max(CONTENT_MAX).optional(),
  })
  .passthrough()

const openAIResponsesInputItem = z.union([
  z.object({
    type: z.literal("message"),
    role: z.enum(["system", "developer", "user", "assistant", "tool"]),
    content: z.union([z.string().max(CONTENT_MAX), z.array(openAIContentBlock)]),
  }),
  z.object({
    type: z.literal("input_text"),
    text: z.string().max(CONTENT_MAX),
  }),
  z.object({
    type: z.literal("input_image"),
    image_url: z.string().optional(),
  }),
])

const chatRequest = z.object({
  model: z.string().min(1),
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "developer", "user", "assistant", "tool"]),
        content: z.union([z.string().max(CONTENT_MAX), z.array(openAIContentBlock)]),
      }),
    )
    .min(1)
    .max(MESSAGE_MAX),
  max_tokens: z.number().int().positive().optional(),
  stream: z.boolean().optional(),
})

const responsesRequest = z.object({
  model: z.string().min(1),
  input: z.union([
    z.string().max(CONTENT_MAX),
    z.array(openAIResponsesInputItem).min(1).max(MESSAGE_MAX),
    z
      .array(
        z.object({
          role: z.enum(["system", "developer", "user", "assistant", "tool"]),
          content: z.union([z.string().max(CONTENT_MAX), z.array(openAIContentBlock)]),
        }),
      )
      .min(1)
      .max(MESSAGE_MAX),
  ]),
  max_output_tokens: z.number().int().positive().optional(),
  stream: z.boolean().optional(),
})

function normalizeResponsesInput(input: z.infer<typeof responsesRequest>["input"]) {
  if (typeof input === "string") {
    return [
      {
        role: "user",
        content: input,
      },
    ]
  }
  if (!input.length) return []
  const first = input[0]
  if ("role" in first && typeof first.role === "string") {
    return input as Array<{ role: string; content: string | Array<Record<string, unknown>> }>
  }
  return (input as Array<Record<string, unknown>>)
    .map((item) => {
      if (
        item.type === "message" &&
        typeof item.role === "string" &&
        (typeof item.content === "string" || Array.isArray(item.content))
      ) {
        return {
          role: item.role,
          content: item.content,
        }
      }
      if (item.type === "input_text" && typeof item.text === "string") {
        return {
          role: "user",
          content: item.text,
        }
      }
      if (item.type !== "input_image") return undefined
      return {
        role: "user",
        content: [{ type: "input_image", image_url: typeof item.image_url === "string" ? item.image_url : "" }],
      }
    })
    .filter((item): item is { role: string; content: string | Array<Record<string, unknown>> } => {
      if (!item) return false
      if (typeof item.content !== "string") return true
      return item.content !== ""
    })
}

async function enabled() {
  return (await Config.get()).server?.compat?.openai?.enabled === true
}

async function limit() {
  const compat = (await Config.get()).server?.compat
  return compat?.openai?.max_output_tokens ?? compat?.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS
}

export function OpenAICompatRoutes() {
  return new Hono()
    .get("/v1/models", async (c) => {
      if (!(await enabled())) return new Response("Not Found", { status: 404 })
      const auth = await requireOpenAIBearer(c.req.raw)
      if (typeof auth !== "string") return auth

      const models = await listModels("openai")
      return c.json({
        object: "list",
        data: models.map((id) => ({
          id,
          object: "model",
          created: 0,
          owned_by: "opencode",
        })),
      })
    })
    .post("/v1/chat/completions", async (c) => {
      if (!(await enabled())) return new Response("Not Found", { status: 404 })
      const auth = await requireOpenAIBearer(c.req.raw)
      if (typeof auth !== "string") return auth

      const body = await parseJSONBody(c.req.raw, "openai").catch(() => undefined)
      if (!body?.ok) return body?.response ?? openAIError("bad_request", "Invalid request")
      const parsed = chatRequest.safeParse(body.json)
      if (!parsed.success) return openAIError("bad_request", "Invalid request")
      const maxOutputTokens = await limit()
      if (parsed.data.max_tokens && parsed.data.max_tokens > maxOutputTokens) {
        return openAIError("bad_request", `max_tokens must be less than or equal to ${maxOutputTokens}`)
      }
      const model = await resolveModel("openai", parsed.data.model).catch(() => undefined)
      if (!model) return openAIError("unknown_model", `The model '${parsed.data.model}' does not exist.`)
      if (parsed.data.stream) {
        const started = await startCompat({
          provider: "openai",
          model: model.publicModel,
          resolvedModel: model.resolvedModel,
          stream: true,
          maxOutputTokens: parsed.data.max_tokens,
          input: parsed.data.messages,
        }).catch(() => undefined)
        if (!started) return openAIError("api_error", "Failed to start streaming session")
        return openAIChatSessionStream({
          sessionID: started.sessionID,
          model: started.model,
          pending: started.pending,
          maxOutputTokens: parsed.data.max_tokens,
          signal: c.req.raw.signal,
        })
      }
      const result = await executeCompat({
        provider: "openai",
        model: model.publicModel,
        resolvedModel: model.resolvedModel,
        stream: false,
        maxOutputTokens: parsed.data.max_tokens,
        input: parsed.data.messages,
      }).catch((error) => (error instanceof CompatTimeoutError ? "timeout" : undefined))
      if (result === "timeout") return openAIError("upstream_timeout", "Request timed out")
      if (!result) return openAIError("api_error", "Execution failed")
      const text = result.output
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n")
      const tools = result.output
        .filter((item) => item.type === "tool_use")
        .map((item) => ({
          id: item.id,
          type: "function",
          function: {
            name: item.name,
            arguments: JSON.stringify(item.input),
          },
        }))
      return c.json({
        id: result.id,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: result.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: tools.length ? null : text,
              ...(tools.length ? { tool_calls: tools } : {}),
            },
            finish_reason:
              result.stopReason === "max_tokens" ? "length" : result.stopReason === "tool_use" ? "tool_calls" : "stop",
          },
        ],
        usage: {
          prompt_tokens: result.usage.inputTokens,
          completion_tokens: result.usage.outputTokens,
          total_tokens: result.usage.inputTokens + result.usage.outputTokens,
        },
      })
    })
    .post("/v1/responses", async (c) => {
      if (!(await enabled())) return new Response("Not Found", { status: 404 })
      const auth = await requireOpenAIBearer(c.req.raw)
      if (typeof auth !== "string") return auth

      const body = await parseJSONBody(c.req.raw, "openai").catch(() => undefined)
      if (!body?.ok) return body?.response ?? openAIError("bad_request", "Invalid request")
      const parsed = responsesRequest.safeParse(body.json)
      if (!parsed.success) return openAIError("bad_request", "Invalid request")
      const maxOutputTokens = await limit()
      if (parsed.data.max_output_tokens && parsed.data.max_output_tokens > maxOutputTokens) {
        return openAIError("bad_request", `max_output_tokens must be less than or equal to ${maxOutputTokens}`)
      }
      const model = await resolveModel("openai", parsed.data.model).catch(() => undefined)
      if (!model) return openAIError("unknown_model", `The model '${parsed.data.model}' does not exist.`)
      const input = normalizeResponsesInput(parsed.data.input)
      if (parsed.data.stream) {
        const started = await startCompat({
          provider: "openai",
          model: model.publicModel,
          resolvedModel: model.resolvedModel,
          stream: true,
          maxOutputTokens: parsed.data.max_output_tokens,
          input,
        }).catch(() => undefined)
        if (!started) return openAIError("api_error", "Failed to start streaming session")
        return openAIResponsesSessionStream({
          sessionID: started.sessionID,
          model: started.model,
          pending: started.pending,
          maxOutputTokens: parsed.data.max_output_tokens,
          signal: c.req.raw.signal,
        })
      }
      const result = await executeCompat({
        provider: "openai",
        model: model.publicModel,
        resolvedModel: model.resolvedModel,
        stream: false,
        maxOutputTokens: parsed.data.max_output_tokens,
        input,
      }).catch((error) => (error instanceof CompatTimeoutError ? "timeout" : undefined))
      if (result === "timeout") return openAIError("upstream_timeout", "Request timed out")
      if (!result) return openAIError("api_error", "Execution failed")
      return c.json({
        id: result.id,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        model: result.model,
        output: [
          {
            type: "message",
            role: "assistant",
            content: result.output.map((item) =>
              item.type === "text"
                ? { type: "output_text", text: item.text }
                : {
                    type: "tool_call",
                    id: item.id,
                    name: item.name,
                    input: item.input,
                  },
            ),
          },
        ],
        usage: {
          input_tokens: result.usage.inputTokens,
          output_tokens: result.usage.outputTokens,
          total_tokens: result.usage.inputTokens + result.usage.outputTokens,
        },
      })
    })
}
