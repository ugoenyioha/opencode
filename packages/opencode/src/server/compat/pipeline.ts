import type { CompatRequest, CompatResponse } from "./types"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { MessageV2 } from "@/session/message-v2"
import { Provider } from "@/provider/provider"

const EXECUTION_TIMEOUT_MS = 120_000

export class CompatTimeoutError extends Error {
  constructor() {
    super("Compatibility request timed out")
    this.name = "CompatTimeoutError"
  }
}

function promptText(req: CompatRequest) {
  return req.input.map((item) => `${item.role.toUpperCase()}: ${contentText(item.content)}`).join("\n\n")
}

function blockText(block: Record<string, unknown>) {
  if (block.type === "text") {
    if (typeof block.text === "string") return block.text
    return ""
  }
  const kind = typeof block.type === "string" ? block.type : "unknown"
  return `[${kind}] ${JSON.stringify(block)}`
}

function contentText(content: CompatRequest["input"][number]["content"]) {
  if (typeof content === "string") return content
  return content.map(blockText).filter(Boolean).join("\n")
}

function stopReason(finish: string | undefined): CompatResponse["stopReason"] {
  if (!finish) return "stop"
  if (finish.includes("length")) return "max_tokens"
  if (finish.includes("tool")) return "tool_use"
  if (finish.includes("error")) return "error"
  return "stop"
}

function clampOutput(input: CompatResponse, maxOutputTokens: number | undefined) {
  if (!maxOutputTokens) return input
  if (input.usage.outputTokens <= maxOutputTokens) return input
  const text = input.output.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")
  const words = text.trim().split(/\s+/).filter(Boolean)
  const limited = words.slice(0, maxOutputTokens).join(" ")
  return {
    ...input,
    output: [{ type: "text" as const, text: limited }, ...input.output.filter((item) => item.type === "tool_use")],
    usage: {
      ...input.usage,
      outputTokens: maxOutputTokens,
    },
    stopReason: "max_tokens" as const,
  }
}

function withTimeout<T>(promise: Promise<T>, timeout: number) {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => {
        reject(new CompatTimeoutError())
      }, timeout),
    ),
  ])
}

async function executeSession(req: CompatRequest): Promise<CompatResponse> {
  const started = await startCompat(req)
  await withTimeout(started.pending, EXECUTION_TIMEOUT_MS).catch((error) => {
    if (error instanceof CompatTimeoutError) {
      SessionPrompt.cancel(started.sessionID)
    }
    throw error
  })
  const messages = await Session.messages({ sessionID: started.sessionID })
  const assistant = messages.findLast((item) => item.info.role === "assistant")
  if (!assistant) {
    throw new Error("No assistant message generated")
  }
  const text = assistant.parts
    .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic)
    .map((part) => part.text)
    .join("\n")
  const tools = assistant.parts
    .filter((part): part is MessageV2.ToolPart => part.type === "tool")
    .map((part) => ({
      type: "tool_use" as const,
      id: part.callID,
      name: part.tool,
      input: part.state.input,
    }))
  const info = assistant.info as MessageV2.Assistant
  return clampOutput(
    {
      id: info.id,
      model: req.model,
      output: [{ type: "text", text: text || "" }, ...tools],
      usage: {
        inputTokens: info.tokens.input,
        outputTokens: info.tokens.output,
      },
      stopReason: stopReason(info.finish),
    },
    req.maxOutputTokens,
  )
}

export async function executeCompat(req: CompatRequest): Promise<CompatResponse> {
  return executeSession(req)
}

export async function startCompat(req: CompatRequest) {
  const model = Provider.parseModel(req.resolvedModel)
  await Provider.getModel(model.providerID, model.modelID)
  const session = await Session.create({})
  const pending = SessionPrompt.prompt({
    sessionID: session.id,
    model,
    parts: [
      {
        type: "text",
        text: promptText(req),
      },
    ],
  })
  return {
    sessionID: session.id,
    model: req.model,
    pending,
  }
}
