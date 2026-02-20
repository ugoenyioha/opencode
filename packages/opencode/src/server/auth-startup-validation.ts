import type { Config } from "@/config/config"

export type AuthConfigStartupErrorCode =
  | "AUTH_CONFIG_MISSING"
  | "AUTH_CONFIG_INVALID_URL"
  | "AUTH_CONFIG_CONFLICT"
  | "AUTH_CONFIG_BOUNDS"
  | "AUTH_CONFIG_UNSUPPORTED_REF"

type StartupStrategy = "api-key" | "plugin" | "jwt" | "oidc" | "oauth2"

type ValidatorContext = {
  config: Config.Info
  getEnv: (key: string) => string | undefined
  getApiKey: () => string | undefined
  hasExternalHttpHook: () => Promise<boolean>
}

const SUPPORTED_STRATEGIES = new Set<StartupStrategy>(["api-key", "plugin", "jwt", "oidc", "oauth2"])
const SUPPORTED_INTROSPECTION_AUTH_METHODS = new Set([
  "client_secret_basic",
  "client_secret_post",
  "bearer_client_credentials",
])
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

function parseList(input: string | undefined) {
  if (!input) return []
  return input
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function parseURL(input: string) {
  try {
    return new URL(input)
  } catch {
    return
  }
}

function isExactLoopback(host: string) {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase())
}

function classifyPath(pathname: string) {
  const normalized = pathname.trim().toLowerCase()
  if (!normalized || normalized === "/") return "root"
  if (normalized.startsWith("/.well-known")) return "well_known"
  if (normalized.includes("oauth") || normalized.includes("token") || normalized.includes("introspect")) {
    return "oauth"
  }
  return "custom"
}

function sanitizeURL(url: URL) {
  const scheme = url.protocol.replace(":", "").toLowerCase() || "unknown"
  const hostClass = isExactLoopback(url.hostname) ? "loopback" : "non_loopback"
  const pathClass = classifyPath(url.pathname)
  return `scheme=${scheme} host_class=${hostClass} path_class=${pathClass}`
}

function isAllowedAuthURL(url: URL) {
  if (url.protocol === "https:") return true
  if (url.protocol === "http:" && isExactLoopback(url.hostname)) return true
  return false
}

export class AuthConfigStartupError extends Error {
  readonly code: AuthConfigStartupErrorCode
  readonly strategy: string
  readonly key: string
  readonly reason: string

  constructor(params: { code: AuthConfigStartupErrorCode; strategy: string; key: string; reason: string; detail?: string }) {
    const detail = params.detail ? ` ${params.detail}` : ""
    super(`${params.code} strategy=${params.strategy} key=${params.key} reason=${params.reason}${detail}`)
    this.name = "AuthConfigStartupError"
    this.code = params.code
    this.strategy = params.strategy
    this.key = params.key
    this.reason = params.reason
  }
}

function fail(params: { code: AuthConfigStartupErrorCode; strategy: string; key: string; reason: string; detail?: string }): never {
  throw new AuthConfigStartupError(params)
}

function validateAuthURL(strategy: StartupStrategy, key: string, raw: string) {
  const parsed = parseURL(raw)
  if (!parsed) {
    fail({
      code: "AUTH_CONFIG_INVALID_URL",
      strategy,
      key,
      reason: "unparseable",
      detail: "url_class=invalid",
    })
  }
  if (!isAllowedAuthURL(parsed)) {
    fail({
      code: "AUTH_CONFIG_INVALID_URL",
      strategy,
      key,
      reason: "requires_https_or_exact_loopback_http",
      detail: `url_class=${sanitizeURL(parsed)}`,
    })
  }
}

function validateClockSkewBounds(getEnv: ValidatorContext["getEnv"]) {
  const raw = getEnv("OPENCODE_COMPAT_JWT_CLOCK_SKEW_SECONDS")
  if (!raw) return
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 300) {
    fail({
      code: "AUTH_CONFIG_BOUNDS",
      strategy: "global",
      key: "env.OPENCODE_COMPAT_JWT_CLOCK_SKEW_SECONDS",
      reason: "must_be_integer_between_0_and_300",
    })
  }
}

function validateIntrospectionTimeoutBounds(getEnv: ValidatorContext["getEnv"]) {
  const raw = getEnv("OPENCODE_COMPAT_OAUTH_INTROSPECTION_TIMEOUT_MS")
  if (!raw) return
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 120000) {
    fail({
      code: "AUTH_CONFIG_BOUNDS",
      strategy: "oauth2",
      key: "env.OPENCODE_COMPAT_OAUTH_INTROSPECTION_TIMEOUT_MS",
      reason: "must_be_integer_between_1_and_120000",
    })
  }
}

function validateJWTConfig(getEnv: ValidatorContext["getEnv"]) {
  const jwks = getEnv("OPENCODE_COMPAT_JWT_JWKS_URL")
  const hs256 = getEnv("OPENCODE_COMPAT_JWT_HS256_SECRET")
  if (!jwks && !hs256) {
    fail({
      code: "AUTH_CONFIG_MISSING",
      strategy: "jwt",
      key: "env.OPENCODE_COMPAT_JWT_JWKS_URL|env.OPENCODE_COMPAT_JWT_HS256_SECRET",
      reason: "requires_one_key_source",
    })
  }
  if (jwks && hs256) {
    fail({
      code: "AUTH_CONFIG_CONFLICT",
      strategy: "jwt",
      key: "env.OPENCODE_COMPAT_JWT_JWKS_URL|env.OPENCODE_COMPAT_JWT_HS256_SECRET",
      reason: "mutually_exclusive_key_sources",
    })
  }
  if (jwks) {
    validateAuthURL("jwt", "env.OPENCODE_COMPAT_JWT_JWKS_URL", jwks)
  }
}

function validateOIDCConfig(getEnv: ValidatorContext["getEnv"]) {
  const issuer = getEnv("OPENCODE_COMPAT_OIDC_ISSUER")
  if (!issuer) {
    fail({
      code: "AUTH_CONFIG_MISSING",
      strategy: "oidc",
      key: "env.OPENCODE_COMPAT_OIDC_ISSUER",
      reason: "required",
    })
  }
  validateAuthURL("oidc", "env.OPENCODE_COMPAT_OIDC_ISSUER", issuer)

  const allowedAlgs = parseList(getEnv("OPENCODE_COMPAT_OIDC_ALGS"))
  if (allowedAlgs.some((alg) => alg.toLowerCase() === "none")) {
    fail({
      code: "AUTH_CONFIG_UNSUPPORTED_REF",
      strategy: "oidc",
      key: "env.OPENCODE_COMPAT_OIDC_ALGS",
      reason: "alg_none_disallowed",
    })
  }
  if (allowedAlgs.some((alg) => alg !== "RS256")) {
    fail({
      code: "AUTH_CONFIG_UNSUPPORTED_REF",
      strategy: "oidc",
      key: "env.OPENCODE_COMPAT_OIDC_ALGS",
      reason: "only_rs256_supported",
    })
  }
}

function validateOAuth2Config(getEnv: ValidatorContext["getEnv"]) {
  const introspectionURL = getEnv("OPENCODE_COMPAT_OAUTH_INTROSPECTION_URL")
  const clientID = getEnv("OPENCODE_COMPAT_OAUTH_CLIENT_ID")
  const clientSecret = getEnv("OPENCODE_COMPAT_OAUTH_CLIENT_SECRET")

  if (!introspectionURL) {
    fail({
      code: "AUTH_CONFIG_MISSING",
      strategy: "oauth2",
      key: "env.OPENCODE_COMPAT_OAUTH_INTROSPECTION_URL",
      reason: "required",
    })
  }
  if (!clientID) {
    fail({
      code: "AUTH_CONFIG_MISSING",
      strategy: "oauth2",
      key: "env.OPENCODE_COMPAT_OAUTH_CLIENT_ID",
      reason: "required",
    })
  }
  if (!clientSecret) {
    fail({
      code: "AUTH_CONFIG_MISSING",
      strategy: "oauth2",
      key: "env.OPENCODE_COMPAT_OAUTH_CLIENT_SECRET",
      reason: "required",
    })
  }

  validateAuthURL("oauth2", "env.OPENCODE_COMPAT_OAUTH_INTROSPECTION_URL", introspectionURL)
  validateIntrospectionTimeoutBounds(getEnv)

  const authMethod = getEnv("OPENCODE_COMPAT_OAUTH_INTROSPECTION_AUTH_METHOD") ?? "client_secret_basic"
  if (!SUPPORTED_INTROSPECTION_AUTH_METHODS.has(authMethod)) {
    fail({
      code: "AUTH_CONFIG_UNSUPPORTED_REF",
      strategy: "oauth2",
      key: "env.OPENCODE_COMPAT_OAUTH_INTROSPECTION_AUTH_METHOD",
      reason: "unsupported_auth_method",
    })
  }

  const explicitTokenURL = getEnv("OPENCODE_COMPAT_OAUTH_INTROSPECTION_TOKEN_URL")
  if (explicitTokenURL) {
    validateAuthURL("oauth2", "env.OPENCODE_COMPAT_OAUTH_INTROSPECTION_TOKEN_URL", explicitTokenURL)
  }
}

export async function validateStartupAuthConfig(context: ValidatorContext) {
  const endpoint = context.config.server?.toolEndpoint
  if (!endpoint?.enabled) return

  const rawStrategy = endpoint.auth ?? "api-key"
  if (!SUPPORTED_STRATEGIES.has(rawStrategy)) {
    fail({
      code: "AUTH_CONFIG_UNSUPPORTED_REF",
      strategy: "unknown",
      key: "server.toolEndpoint.auth",
      reason: "unsupported_strategy_reference",
    })
  }

  validateClockSkewBounds(context.getEnv)

  switch (rawStrategy) {
    case "api-key": {
      if (!context.getApiKey()) {
        fail({
          code: "AUTH_CONFIG_MISSING",
          strategy: "api-key",
          key: "env.OPENCODE_TOOL_ENDPOINT_API_KEY",
          reason: "required",
        })
      }
      return
    }
    case "plugin": {
      const hasExternalHttpHook = await context.hasExternalHttpHook()
      if (!hasExternalHttpHook) {
        fail({
          code: "AUTH_CONFIG_MISSING",
          strategy: "plugin",
          key: "plugin.http.request",
          reason: "external_hook_required",
        })
      }
      return
    }
    case "jwt": {
      validateJWTConfig(context.getEnv)
      return
    }
    case "oidc": {
      validateOIDCConfig(context.getEnv)
      return
    }
    case "oauth2": {
      validateOAuth2Config(context.getEnv)
      return
    }
  }
}
