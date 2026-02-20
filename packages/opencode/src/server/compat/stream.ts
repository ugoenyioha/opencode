import { Bus } from "@/bus"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session"
import { SessionStatus } from "@/session/status"
import { SessionPrompt } from "@/session/prompt"

const encoder = new TextEncoder()
const STREAM_TIMEOUT_MS = 120_000

function finishOpenAI(value: string | undefined) {
  if (value === "max_tokens") return "length"
  if (value === "tool_use") return "tool_calls"
  return "stop"
}

function finishAnthropic(value: string | undefined) {
  if (value === "max_tokens") return "max_tokens"
  if (value === "tool_use") return "tool_use"
  if (value === "error") return "error"
  return "end_turn"
}

async function finalMessage(sessionID: string) {
  const messages = await Session.messages({ sessionID })
  const assistant = messages.findLast((item) => item.info.role === "assistant")
  if (!assistant) return
  const info = assistant.info as MessageV2.Assistant
  return {
    finish: info.finish,
    usage: {
      input: info.tokens.input,
      output: info.tokens.output,
    },
  }
}

function errorText(error: { name: string; data?: Record<string, unknown> } | undefined) {
  void error
  return "Internal server error"
}

type Input = {
  sessionID: string
  model: string
  pending: Promise<unknown>
  maxOutputTokens?: number
  signal?: AbortSignal
}

function words(input: string) {
  return input.trim().split(/\s+/).filter(Boolean).length
}

export function openAIChatSessionStream(input: Input) {
  return new Response(
    new ReadableStream({
      start(controller) {
        let done = false
        let outputTokens = 0
        let capped = false
        const created = Math.floor(Date.now() / 1000)
        const timer = setTimeout(() => {
          if (done) return
          SessionPrompt.cancel(input.sessionID)
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                error: {
                  message: "Request timed out",
                  type: "api_error",
                  code: "upstream_timeout",
                },
              })}\n\n`,
            ),
          )
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          close()
        }, STREAM_TIMEOUT_MS)
        const close = () => {
          if (done) return
          done = true
          clearTimeout(timer)
          unsubDelta()
          unsubStatus()
          unsubError()
          controller.close()
        }

        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              id: input.sessionID,
              object: "chat.completion.chunk",
              created,
              model: input.model,
              choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
            })}\n\n`,
          ),
        )

        const unsubDelta = Bus.subscribe(MessageV2.Event.PartDelta, (event) => {
          if (done) return
          if (event.properties.sessionID !== input.sessionID) return
          if (event.properties.field !== "text") return
          outputTokens += words(event.properties.delta)
          if (input.maxOutputTokens && outputTokens > input.maxOutputTokens) {
            capped = true
            SessionPrompt.cancel(input.sessionID)
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  id: input.sessionID,
                  object: "chat.completion.chunk",
                  created,
                  model: input.model,
                  choices: [{ index: 0, delta: {}, finish_reason: "length" }],
                })}\n\n`,
              ),
            )
            controller.enqueue(encoder.encode("data: [DONE]\n\n"))
            close()
            return
          }
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id: input.sessionID,
                object: "chat.completion.chunk",
                created,
                model: input.model,
                choices: [{ index: 0, delta: { content: event.properties.delta }, finish_reason: null }],
              })}\n\n`,
            ),
          )
        })

        const unsubStatus = Bus.subscribe(SessionStatus.Event.Status, async (event) => {
          if (done) return
          if (event.properties.sessionID !== input.sessionID) return
          if (event.properties.status.type !== "idle") return
          const last = await finalMessage(input.sessionID)
          if (done) return
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id: input.sessionID,
                object: "chat.completion.chunk",
                created,
                model: input.model,
                choices: [{ index: 0, delta: {}, finish_reason: capped ? "length" : finishOpenAI(last?.finish) }],
              })}\n\n`,
            ),
          )
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          close()
        })

        const unsubError = Bus.subscribe(Session.Event.Error, (event) => {
          if (done) return
          if (event.properties.sessionID !== input.sessionID) return
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                error: {
                  message: errorText(event.properties.error),
                  type: "api_error",
                  code: "internal_error",
                },
              })}\n\n`,
            ),
          )
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          close()
        })

        input.pending
          .then(async () => {
            if (done) return
            const last = await finalMessage(input.sessionID)
            if (done) return
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  id: input.sessionID,
                  object: "chat.completion.chunk",
                  created,
                  model: input.model,
                  choices: [{ index: 0, delta: {}, finish_reason: capped ? "length" : finishOpenAI(last?.finish) }],
                })}\n\n`,
              ),
            )
            controller.enqueue(encoder.encode("data: [DONE]\n\n"))
            close()
          })
          .catch(() => {
            if (done) return
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  error: {
                    message: "Internal server error",
                    type: "api_error",
                    code: "internal_error",
                  },
                })}\n\n`,
              ),
            )
            controller.enqueue(encoder.encode("data: [DONE]\n\n"))
            close()
          })
        input.signal?.addEventListener("abort", () => {
          SessionPrompt.cancel(input.sessionID)
          close()
        })
      },
    }),
    {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    },
  )
}

export function openAIResponsesSessionStream(input: Input) {
  return new Response(
    new ReadableStream({
      start(controller) {
        let done = false
        let outputTokens = 0
        let outputText = ""
        const itemID = `${input.sessionID}_msg_0`
        const timer = setTimeout(() => {
          if (done) return
          SessionPrompt.cancel(input.sessionID)
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "error",
                error: {
                  message: "Request timed out",
                  code: "upstream_timeout",
                },
              })}\n\n`,
            ),
          )
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "response.completed",
                response: { id: input.sessionID, status: "failed" },
              })}\n\n`,
            ),
          )
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          close()
        }, STREAM_TIMEOUT_MS)
        const close = () => {
          if (done) return
          done = true
          clearTimeout(timer)
          unsubDelta()
          unsubStatus()
          unsubError()
          controller.close()
        }

        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type: "response.created",
              response: { id: input.sessionID, model: input.model, status: "in_progress" },
            })}\n\n`,
          ),
        )
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type: "response.in_progress",
              response: { id: input.sessionID, model: input.model, status: "in_progress" },
            })}\n\n`,
          ),
        )
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type: "response.output_item.added",
              output_index: 0,
              item: {
                id: itemID,
                type: "message",
                role: "assistant",
                content: [],
              },
            })}\n\n`,
          ),
        )
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type: "response.content_part.added",
              output_index: 0,
              item_id: itemID,
              content_index: 0,
              part: { type: "output_text", text: "" },
            })}\n\n`,
          ),
        )

        const unsubDelta = Bus.subscribe(MessageV2.Event.PartDelta, (event) => {
          if (done) return
          if (event.properties.sessionID !== input.sessionID) return
          if (event.properties.field !== "text") return
          outputTokens += words(event.properties.delta)
          outputText += event.properties.delta
          if (input.maxOutputTokens && outputTokens > input.maxOutputTokens) {
            SessionPrompt.cancel(input.sessionID)
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "response.completed",
                  response: { id: input.sessionID, status: "completed", stop_reason: "max_tokens" },
                })}\n\n`,
              ),
            )
            controller.enqueue(encoder.encode("data: [DONE]\n\n"))
            close()
            return
          }
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "response.output_text.delta",
                output_index: 0,
                item_id: itemID,
                content_index: 0,
                delta: event.properties.delta,
              })}\n\n`,
            ),
          )
        })

        const unsubStatus = Bus.subscribe(SessionStatus.Event.Status, async (event) => {
          if (done) return
          if (event.properties.sessionID !== input.sessionID) return
          if (event.properties.status.type !== "idle") return
          const last = await finalMessage(input.sessionID)
          if (done) return
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "response.output_text.done",
                output_index: 0,
                item_id: itemID,
                content_index: 0,
                text: outputText,
              })}\n\n`,
            ),
          )
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "response.content_part.done",
                output_index: 0,
                item_id: itemID,
                content_index: 0,
              })}\n\n`,
            ),
          )
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "response.output_item.done",
                output_index: 0,
                item: {
                  id: itemID,
                  type: "message",
                  role: "assistant",
                },
              })}\n\n`,
            ),
          )
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "response.completed",
                response: {
                  id: input.sessionID,
                  status: "completed",
                  stop_reason: finishOpenAI(last?.finish),
                  usage: {
                    input_tokens: last?.usage.input ?? 0,
                    output_tokens: last?.usage.output ?? 0,
                    total_tokens: (last?.usage.input ?? 0) + (last?.usage.output ?? 0),
                  },
                },
              })}\n\n`,
            ),
          )
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          close()
        })

        const unsubError = Bus.subscribe(Session.Event.Error, (event) => {
          if (done) return
          if (event.properties.sessionID !== input.sessionID) return
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "error",
                error: {
                  message: errorText(event.properties.error),
                },
              })}\n\n`,
            ),
          )
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          close()
        })

        input.pending
          .then(async () => {
            if (done) return
            const last = await finalMessage(input.sessionID)
            if (done) return
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "response.output_text.done",
                  output_index: 0,
                  item_id: itemID,
                  content_index: 0,
                  text: outputText,
                })}\n\n`,
              ),
            )
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "response.content_part.done",
                  output_index: 0,
                  item_id: itemID,
                  content_index: 0,
                })}\n\n`,
              ),
            )
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "response.output_item.done",
                  output_index: 0,
                  item: {
                    id: itemID,
                    type: "message",
                    role: "assistant",
                  },
                })}\n\n`,
              ),
            )
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "response.completed",
                  response: {
                    id: input.sessionID,
                    status: "completed",
                    stop_reason: finishOpenAI(last?.finish),
                    usage: {
                      input_tokens: last?.usage.input ?? 0,
                      output_tokens: last?.usage.output ?? 0,
                      total_tokens: (last?.usage.input ?? 0) + (last?.usage.output ?? 0),
                    },
                  },
                })}\n\n`,
              ),
            )
            controller.enqueue(encoder.encode("data: [DONE]\n\n"))
            close()
          })
          .catch(() => {
            if (done) return
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "error",
                  error: {
                    message: "Internal server error",
                    code: "internal_error",
                  },
                })}\n\n`,
              ),
            )
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "response.completed",
                  response: { id: input.sessionID, status: "failed" },
                })}\n\n`,
              ),
            )
            controller.enqueue(encoder.encode("data: [DONE]\n\n"))
            close()
          })
        input.signal?.addEventListener("abort", () => {
          SessionPrompt.cancel(input.sessionID)
          close()
        })
      },
    }),
    {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    },
  )
}

export function anthropicMessageSessionStream(input: Input) {
  return new Response(
    new ReadableStream({
      start(controller) {
        let done = false
        let outputTokens = 0
        let capped = false
        const timer = setTimeout(() => {
          if (done) return
          SessionPrompt.cancel(input.sessionID)
          controller.enqueue(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify({
                type: "error",
                error: {
                  type: "api_error",
                  message: "Request timed out",
                },
              })}\n\n`,
            ),
          )
          close()
        }, STREAM_TIMEOUT_MS)
        const close = () => {
          if (done) return
          done = true
          clearTimeout(timer)
          unsubDelta()
          unsubStatus()
          unsubError()
          controller.close()
        }

        controller.enqueue(
          encoder.encode(
            `event: message_start\ndata: ${JSON.stringify({
              type: "message_start",
              message: {
                id: input.sessionID,
                type: "message",
                role: "assistant",
                model: input.model,
              },
            })}\n\n`,
          ),
        )
        controller.enqueue(
          encoder.encode(
            `event: content_block_start\ndata: ${JSON.stringify({
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            })}\n\n`,
          ),
        )

        const unsubDelta = Bus.subscribe(MessageV2.Event.PartDelta, (event) => {
          if (done) return
          if (event.properties.sessionID !== input.sessionID) return
          if (event.properties.field !== "text") return
          outputTokens += words(event.properties.delta)
          if (input.maxOutputTokens && outputTokens > input.maxOutputTokens) {
            capped = true
            SessionPrompt.cancel(input.sessionID)
            controller.enqueue(
              encoder.encode(
                `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
              ),
            )
            controller.enqueue(
              encoder.encode(
                `event: message_delta\ndata: ${JSON.stringify({
                  type: "message_delta",
                  delta: { stop_reason: "max_tokens" },
                  usage: {
                    input_tokens: 0,
                    output_tokens: input.maxOutputTokens,
                  },
                })}\n\n`,
              ),
            )
            controller.enqueue(
              encoder.encode(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`),
            )
            close()
            return
          }
          controller.enqueue(
            encoder.encode(
              `event: content_block_delta\ndata: ${JSON.stringify({
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: event.properties.delta },
              })}\n\n`,
            ),
          )
        })

        const unsubStatus = Bus.subscribe(SessionStatus.Event.Status, async (event) => {
          if (done) return
          if (event.properties.sessionID !== input.sessionID) return
          if (event.properties.status.type !== "idle") return
          const last = await finalMessage(input.sessionID)
          if (done) return
          controller.enqueue(
            encoder.encode(
              `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
            ),
          )
          controller.enqueue(
            encoder.encode(
              `event: message_delta\ndata: ${JSON.stringify({
                type: "message_delta",
                delta: { stop_reason: capped ? "max_tokens" : finishAnthropic(last?.finish) },
                usage: {
                  input_tokens: last?.usage.input ?? 0,
                  output_tokens: last?.usage.output ?? 0,
                },
              })}\n\n`,
            ),
          )
          controller.enqueue(
            encoder.encode(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`),
          )
          close()
        })

        const unsubError = Bus.subscribe(Session.Event.Error, (event) => {
          if (done) return
          if (event.properties.sessionID !== input.sessionID) return
          controller.enqueue(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify({
                type: "error",
                error: {
                  type: "api_error",
                  message: errorText(event.properties.error),
                },
              })}\n\n`,
            ),
          )
          close()
        })

        input.pending
          .then(async () => {
            if (done) return
            const last = await finalMessage(input.sessionID)
            if (done) return
            controller.enqueue(
              encoder.encode(
                `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
              ),
            )
            controller.enqueue(
              encoder.encode(
                `event: message_delta\ndata: ${JSON.stringify({
                  type: "message_delta",
                  delta: { stop_reason: capped ? "max_tokens" : finishAnthropic(last?.finish) },
                  usage: {
                    input_tokens: last?.usage.input ?? 0,
                    output_tokens: last?.usage.output ?? 0,
                  },
                })}\n\n`,
              ),
            )
            controller.enqueue(
              encoder.encode(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`),
            )
            close()
          })
          .catch(() => {
            if (done) return
            controller.enqueue(
              encoder.encode(
                `event: error\ndata: ${JSON.stringify({
                  type: "error",
                  error: {
                    type: "api_error",
                    message: "Internal server error",
                  },
                })}\n\n`,
              ),
            )
            close()
          })
        input.signal?.addEventListener("abort", () => {
          SessionPrompt.cancel(input.sessionID)
          close()
        })
      },
    }),
    {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    },
  )
}
