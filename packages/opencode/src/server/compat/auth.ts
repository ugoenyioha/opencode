import { anthropicError, openAIError } from "./error"
import { Env } from "@/env"
import { timingSafeEqual } from "crypto"
import { createHash } from "crypto"

function bearer(input: string | undefined) {
  if (!input) return
  const [scheme, ...rest] = input.split(" ")
  if (scheme.toLowerCase() !== "bearer") return
  const token = rest.join(" ").trim()
  if (!token) return
  return token
}

function apiKey(input: string | undefined) {
  const token = input?.trim()
  if (!token) return
  return token
}

function authorized(token: string) {
  const candidates = [Env.get("OPENCODE_TOOL_ENDPOINT_API_KEY")]
  if (Env.get("OPENCODE_COMPAT_ALLOW_SERVER_PASSWORD") === "true") {
    candidates.push(Env.get("OPENCODE_SERVER_PASSWORD"))
  }
  const values = candidates.filter((value): value is string => !!value)
  const input = createHash("sha256").update(token, "utf8").digest()
  let match = false
  for (const value of values) {
    const candidate = createHash("sha256").update(value, "utf8").digest()
    match = timingSafeEqual(candidate, input) || match
  }
  return match
}

export function requireOpenAIBearer(req: Request) {
  const token =
    bearer(req.headers.get("authorization") ?? undefined) ?? apiKey(req.headers.get("x-api-key") ?? undefined)
  if (token && authorized(token)) return token
  return openAIError("unauthorized", "Unauthorized")
}

export function requireAnthropicHeaders(req: Request) {
  const token = req.headers.get("x-api-key")?.trim()
  if (!token || !authorized(token)) return anthropicError("unauthorized", "Unauthorized")

  return token
}
