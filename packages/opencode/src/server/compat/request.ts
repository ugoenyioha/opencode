import { anthropicError, openAIError } from "./error"
import type { CompatProvider } from "./types"

const BODY_MAX_BYTES = 512 * 1024

function isJSON(contentType: string | null) {
  if (!contentType) return false
  return contentType.toLowerCase().includes("application/json")
}

function parseError(provider: CompatProvider, kind: "bad_request" | "rate_limit", message: string) {
  if (provider === "openai") return openAIError(kind, message)
  return anthropicError(kind, message)
}

export async function parseJSONBody(req: Request, provider: CompatProvider) {
  if (!isJSON(req.headers.get("content-type"))) {
    return {
      ok: false as const,
      response: parseError(provider, "bad_request", "Content-Type must be application/json"),
    }
  }
  const text = await req.text()
  if (Buffer.byteLength(text, "utf8") > BODY_MAX_BYTES) {
    return {
      ok: false as const,
      response: parseError(provider, "rate_limit", "Request body too large"),
    }
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return {
      ok: false as const,
      response: parseError(provider, "bad_request", "Invalid request"),
    }
  }
  return {
    ok: true as const,
    json,
  }
}
