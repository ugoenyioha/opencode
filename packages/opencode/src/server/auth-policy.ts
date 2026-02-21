import type { AuthStrategy } from "@opencode-ai/plugin"
import { Flag } from "@/flag/flag"
import { timingSafeEqual } from "crypto"
import { bearerFromHeaders, verifyBearerForStrategy } from "./compat/auth"
import { normalizeAuthRoute, surfaceFromRoute, type AuthReason, type AuthRoute, type AuthStrategyLabel } from "./auth-observability"

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

/**
 * Result of authentication: identifies the caller.
 * `principal` is the authenticated identity string (e.g. SPIFFE ID, JWT sub,
 * service account). Empty when auth is not applicable or not resolved.
 */
export type AuthnResult = {
  ok: boolean
  strategy: AuthStrategyLabel
  /** The authenticated identity — empty when auth is not required or failed. */
  principal: string
}

export type AuthorizationDecision = {
  ok: boolean
  policyMode: AuthPolicy["mode"]
  route: AuthRoute
  surface: ReturnType<typeof surfaceFromRoute>
  strategy: AuthStrategyLabel
  reason: AuthReason
  /** Authenticated caller identity (SPIFFE ID, JWT sub, etc.). */
  principal: string
}

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

export function validAPIKey(headers: Headers) {
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

/**
 * Evaluate a single auth strategy.
 * Returns the authenticated principal string on success, or `false` on failure.
 * The principal is a human-readable identifier:
 *   - "api-key" for API key auth (no identity beyond "has the key")
 *   - SPIFFE ID (e.g. "spiffe://trust-domain/ns/foo/sa/bar") for SPIFFE
 *   - JWT subject for jwt/oidc/oauth2
 */
async function strategyPasses(
  strategy: AuthStrategy,
  headers: Headers,
  context: { surface: ReturnType<typeof surfaceFromRoute>; route: AuthRoute },
): Promise<string | false> {
  if (strategy === "api-key") return validAPIKey(headers) ? "api-key" : false
  // plugin auth is enforced by explicit plugin hooks (http.request).
  // Do not treat it as pre-authorized at the centralized middleware gate.
  if (strategy === "plugin") return false
  if (strategy === "spiffe") {
    const token = bearerFromHeaders(headers)
    if (!token) return false
    const audience = process.env["OPENCODE_SPIFFE_AUDIENCE"]
    if (!audience) return false
    const allowedIdsRaw = process.env["OPENCODE_SPIFFE_ALLOWED_IDS"]
    const allowedIds = allowedIdsRaw?.split(",").map((s) => s.trim()).filter(Boolean)
    try {
      const { verifySPIFFE } = await import("./spiffe")
      return await verifySPIFFE(token, audience, allowedIds)
    } catch {
      return false
    }
  }
  if (strategy === "jwt" || strategy === "oidc" || strategy === "oauth2") {
    const token = bearerFromHeaders(headers)
    if (!token) return false
    const ok = await verifyBearerForStrategy(strategy, token, {
      surface: context.surface,
      route: context.route,
      source: "centralized",
    })
    // TODO: extract sub/principal from verified JWT claims for richer identity
    return ok ? `${strategy}:verified` : false
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

function strategyLabel(strategy: AuthStrategy): AuthStrategyLabel {
  if (strategy === "api-key") return "api-key"
  if (strategy === "jwt") return "jwt"
  if (strategy === "oidc") return "oidc"
  if (strategy === "oauth2") return "oauth2"
  if (strategy === "spiffe") return "spiffe"
  return "plugin"
}

export async function evaluateAuthorization(
  method: string,
  path: string,
  headers: Headers,
  routeRules: RouteAuthRule[],
): Promise<AuthorizationDecision> {
  const policy = resolvePolicy(method, path, routeRules)
  const route = normalizeAuthRoute(path)
  const surface = surfaceFromRoute(route)

  if (policy.mode === "defer") {
    return {
      ok: true,
      policyMode: "defer",
      route,
      surface,
      strategy: "none",
      reason: "none",
      principal: "",
    }
  }

  if (policy.mode === "public") {
    return {
      ok: true,
      policyMode: "public",
      route,
      surface,
      strategy: "none",
      reason: "none",
      principal: "",
    }
  }

  if (policy.mode === "global-default") {
    const hasPassword = !!Flag.OPENCODE_SERVER_PASSWORD
    const hasApiKey = !!process.env["OPENCODE_TOOL_ENDPOINT_API_KEY"]
    const byApiKey = hasApiKey && validAPIKey(headers)
    const byBasic = hasPassword && validBasicAuth(headers)
    const ok = defaultGatePasses(headers)
    return {
      ok,
      policyMode: "global-default",
      route,
      surface,
      strategy: byApiKey ? "api-key" : byBasic ? "basic" : "none",
      reason: ok ? "none" : hasApiKey ? "invalid_api_key" : "invalid_basic_auth",
      principal: byApiKey ? "api-key" : byBasic ? "basic" : "",
    }
  }

  for (const strategy of policy.anyOf) {
    const principal = await strategyPasses(strategy, headers, { surface, route })
    if (principal !== false) {
      return {
        ok: true,
        policyMode: "strategies",
        route,
        surface,
        strategy: strategyLabel(strategy),
        reason: "none",
        principal,
      }
    }
  }

  return {
    ok: false,
    policyMode: "strategies",
    route,
    surface,
    strategy: "none",
    reason: "invalid_token",
    principal: "",
  }
}

export async function authorizeRequest(method: string, path: string, headers: Headers, routeRules: RouteAuthRule[]) {
  return (await evaluateAuthorization(method, path, headers, routeRules)).ok
}
