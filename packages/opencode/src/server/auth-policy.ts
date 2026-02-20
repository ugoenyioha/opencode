import type { AuthStrategy } from "@opencode-ai/plugin"
import { Flag } from "@/flag/flag"
import { timingSafeEqual } from "crypto"
import { bearerFromHeaders, verifyBearerForStrategy } from "./compat/auth"

export type RouteAuthRule = {
  method: string
  path: string
  auth?: AuthStrategy | AuthStrategy[]
}

type AuthPolicy =
  | { mode: "defer" }
  | { mode: "public" }
  | { mode: "global-default" }
  | { mode: "strategies"; anyOf: AuthStrategy[] }

function pathMatches(reqPath: string, pattern: string): boolean {
  const reqParts = reqPath.split("/")
  const patParts = pattern.split("/")
  if (reqParts.length !== patParts.length) return false
  return patParts.every((pat, i) => pat.startsWith(":") || pat === "*" || pat === reqParts[i])
}

function isOpenAICompatPath(path: string) {
  return path === "/v1/models" || path === "/v1/chat/completions" || path === "/v1/responses"
}

function resolvePolicy(method: string, path: string, routeRules: RouteAuthRule[]): AuthPolicy {
  if (isOpenAICompatPath(path)) return { mode: "defer" }

  const normalizedMethod = method.toUpperCase()
  const route = routeRules.find(
    (rule) => (rule.method === normalizedMethod || rule.method === "ALL") && pathMatches(path, rule.path),
  )

  if (!route || route.auth === undefined) return { mode: "global-default" }
  if (Array.isArray(route.auth) && route.auth.length === 0) return { mode: "public" }

  const list = Array.isArray(route.auth) ? route.auth : [route.auth]
  return { mode: "strategies", anyOf: list }
}

function validAPIKey(headers: Headers) {
  const key = process.env["OPENCODE_TOOL_ENDPOINT_API_KEY"]
  if (!key) return false
  const header = headers.get("x-api-key") ?? ""
  const a = Buffer.from(header, "utf8")
  const b = Buffer.from(key, "utf8")
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function validBasicAuth(headers: Headers) {
  const password = Flag.OPENCODE_SERVER_PASSWORD
  if (!password) return false
  const username = Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
  const header = headers.get("authorization") ?? ""
  if (!header.startsWith("Basic ")) return false
  const encoded = header.slice("Basic ".length).trim()
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8")
    const [user = "", ...rest] = decoded.split(":")
    const pass = rest.join(":")
    const actual = Buffer.from(`${user}:${pass}`, "utf8")
    const expected = Buffer.from(`${username}:${password}`, "utf8")
    if (actual.length !== expected.length) return false
    return timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

async function strategyPasses(strategy: AuthStrategy, headers: Headers) {
  if (strategy === "api-key") return validAPIKey(headers)
  // plugin auth is enforced by explicit plugin hooks (http.request).
  // Do not treat it as pre-authorized at the centralized middleware gate.
  if (strategy === "plugin") return false
  if (strategy === "jwt" || strategy === "oidc" || strategy === "oauth2") {
    const token = bearerFromHeaders(headers)
    if (!token) return false
    return verifyBearerForStrategy(strategy, token)
  }
  return false
}

function defaultGatePasses(headers: Headers) {
  const hasPassword = !!Flag.OPENCODE_SERVER_PASSWORD
  const hasApiKey = !!process.env["OPENCODE_TOOL_ENDPOINT_API_KEY"]
  if (!hasPassword && !hasApiKey) return true
  if (hasApiKey && validAPIKey(headers)) return true
  if (hasPassword && validBasicAuth(headers)) return true
  return false
}

export async function authorizeRequest(method: string, path: string, headers: Headers, routeRules: RouteAuthRule[]) {
  const policy = resolvePolicy(method, path, routeRules)
  if (policy.mode === "defer" || policy.mode === "public") return true
  if (policy.mode === "global-default") return defaultGatePasses(headers)
  for (const strategy of policy.anyOf) {
    if (await strategyPasses(strategy, headers)) return true
  }
  return false
}
