import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Instance } from "@/project/instance"
import { fn } from "@/util/fn"
import z from "zod"

export namespace McpElicitation {
  const TIMEOUT = 5 * 60 * 1000

  const Field = z
    .object({
      name: z.string(),
      label: z.string().optional(),
      type: z.string().optional(),
      required: z.boolean().optional(),
      placeholder: z.string().optional(),
      options: z.array(z.string()).optional(),
    })
    .passthrough()

  export const Prompt = z.union([
    z.string(),
    z
      .object({
        type: z.string().optional(),
        message: z.string().optional(),
        url: z.string().optional(),
        fields: z.array(Field).optional(),
      })
      .passthrough(),
  ])
  export type Prompt = z.infer<typeof Prompt>

  export const Request = z.object({
    sessionID: z.string(),
    requestID: z.string(),
    tool: z.string(),
    prompt: Prompt,
  })
  export type Request = z.infer<typeof Request>

  export const Reply = z
    .object({
      requestID: z.string(),
      text: z.string().optional(),
      data: z.record(z.string(), z.unknown()).optional(),
    })
    .refine((input) => input.text !== undefined || input.data !== undefined, {
      message: "Reply requires text or data.",
    })
  export type Reply = z.infer<typeof Reply>

  export const Reject = z.object({
    requestID: z.string(),
  })
  export type Reject = z.infer<typeof Reject>

  export const Event = {
    Asked: BusEvent.define("mcp.elicitation.asked", Request),
    Replied: BusEvent.define(
      "mcp.elicitation.replied",
      z.object({
        sessionID: z.string(),
        requestID: z.string(),
        text: z.string().optional(),
        data: z.record(z.string(), z.unknown()).optional(),
      }),
    ),
    Rejected: BusEvent.define(
      "mcp.elicitation.rejected",
      z.object({
        sessionID: z.string(),
        requestID: z.string(),
      }),
    ),
  }

  const state = Instance.state(
    () => {
      const pending: Record<
        string,
        {
          request: Request
          resolve: (input: Reply) => void
          reject: (error: unknown) => void
        }
      > = {}
      return {
        pending,
      }
    },
    async (s) => {
      for (const item of Object.values(s.pending)) {
        item.reject(new DOMException("Aborted", "AbortError"))
      }
    },
  )

  export async function ask(input: Request, abort?: AbortSignal) {
    const req = Request.parse(input)
    const s = await state()

    const signal = abort ? AbortSignal.any([abort, AbortSignal.timeout(TIMEOUT)]) : AbortSignal.timeout(TIMEOUT)
    signal.throwIfAborted()

    return new Promise<Reply>((resolve, reject) => {
      const done = () => {
        signal.removeEventListener("abort", onabort)
      }
      const onabort = () => {
        delete s.pending[req.requestID]
        done()
        reject(new DOMException("Aborted", "AbortError"))
      }
      s.pending[req.requestID] = {
        request: req,
        resolve: (val) => {
          done()
          resolve(val)
        },
        reject: (err) => {
          done()
          reject(err)
        },
      }
      signal.addEventListener("abort", onabort, { once: true })
      Bus.publish(Event.Asked, req)
    })
  }

  export const reply = fn(Reply, async (input) => {
    const s = await state()
    const item = s.pending[input.requestID]
    if (!item) return
    delete s.pending[input.requestID]
    Bus.publish(Event.Replied, {
      sessionID: item.request.sessionID,
      requestID: input.requestID,
      text: input.text,
      data: input.data,
    })
    item.resolve(input)
  })

  export const reject = fn(Reject, async (input) => {
    const s = await state()
    const item = s.pending[input.requestID]
    if (!item) return
    delete s.pending[input.requestID]
    Bus.publish(Event.Rejected, {
      sessionID: item.request.sessionID,
      requestID: input.requestID,
    })
    item.reject(new RejectedError())
  })

  export class RejectedError extends Error {
    constructor() {
      super("The user rejected the MCP elicitation request.")
    }
  }
}
