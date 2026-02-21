import { Log } from "@/util/log"

const log = Log.create({ service: "auth" })

export type AuthSurface = "openai" | "anthropic" | "tool" | "a2a" | "server"
export type AuthPolicyMode = "defer" | "public" | "global-default" | "strategies"
export type AuthOutcome = "allow" | "deny" | "defer"
export type AuthSource = "centralized" | "compat" | "verifier"
export type AuthRoute = "openai.compat" | "anthropic.compat" | "tool.endpoint" | "a2a.discovery" | "a2a.protected" | "other"
export type AuthStrategyLabel = "api-key" | "basic" | "jwt" | "oidc" | "oauth2" | "spiffe" | "plugin" | "ext_authz" | "none"

export type AuthReason =
  | "none"
  | "missing_token"
  | "invalid_token"
  | "invalid_api_key"
  | "invalid_basic_auth"
  | "jwt_verifier_error"
  | "oidc_discovery_error"
  | "oauth_introspection_error"
  | "spiffe_endpoint_error"
  | "ext_authz_denied"
  | "ext_authz_error"
  | "ext_authz_timeout"
  | "verifier_internal_error"

type AuthEvent = {
  source: AuthSource
  surface: AuthSurface
  route: AuthRoute
  outcome: AuthOutcome
  policyMode?: AuthPolicyMode
  strategy?: AuthStrategyLabel
  reason?: AuthReason
}

export function normalizeAuthRoute(path: string): AuthRoute {
  if (path === "/v1/models" || path === "/v1/chat/completions" || path === "/v1/responses") return "openai.compat"
  if (path === "/v1/messages" || path === "/v1/messages/count_tokens") return "anthropic.compat"
  if (path === "/tool/:toolName" || path.startsWith("/tool/")) return "tool.endpoint"
  if (path.startsWith("/.well-known/agents") || path === "/.well-known/agent-card.json" || path === "/.well-known/a2a/agent-card")
    return "a2a.discovery"
  if (path.startsWith("/a2a/")) return "a2a.protected"
  return "other"
}

export function surfaceFromRoute(route: AuthRoute): AuthSurface {
  if (route === "openai.compat") return "openai"
  if (route === "anthropic.compat") return "anthropic"
  if (route === "tool.endpoint") return "tool"
  if (route === "a2a.discovery" || route === "a2a.protected") return "a2a"
  return "server"
}

function emit(level: "debug" | "info" | "warn", event: AuthEvent) {
  try {
    const payload = {
      event: "auth_observe",
      source: event.source,
      surface: event.surface,
      route: event.route,
      outcome: event.outcome,
      policy_mode: event.policyMode,
      strategy: event.strategy,
      reason: event.reason ?? "none",
    }
    if (level === "debug") {
      log.debug("auth_observe", payload)
      return
    }
    if (level === "info") {
      log.info("auth_observe", payload)
      return
    }
    log.warn("auth_observe", payload)
  } catch {
    // Observability must never affect auth behavior.
  }
}

export function emitAuthDecision(event: Omit<AuthEvent, "source"> & { source?: "centralized" | "compat" }) {
  const level = event.outcome === "allow" ? "debug" : "info"
  emit(level, {
    ...event,
    source: event.source ?? "centralized",
  })
}

export function emitAuthBoundary(event: { surface: AuthSurface; route: AuthRoute; policyMode: "defer" }) {
  emit("info", {
    source: "centralized",
    surface: event.surface,
    route: event.route,
    policyMode: event.policyMode,
    outcome: "defer",
    strategy: "none",
    reason: "none",
  })
}

export function emitAuthVerifierWarn(event: {
  surface: AuthSurface
  route: AuthRoute
  strategy: AuthStrategyLabel
  reason: Extract<AuthReason, "jwt_verifier_error" | "oidc_discovery_error" | "oauth_introspection_error" | "verifier_internal_error">
}) {
  emit("warn", {
    source: "verifier",
    surface: event.surface,
    route: event.route,
    outcome: "deny",
    strategy: event.strategy,
    reason: event.reason,
  })
}
