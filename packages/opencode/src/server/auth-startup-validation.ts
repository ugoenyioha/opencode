import type { Config } from "@/config/config"

export type AuthConfigStartupErrorCode =
  | "AUTH_CONFIG_MISSING"
  | "AUTH_CONFIG_INVALID_URL"
  | "AUTH_CONFIG_CONFLICT"
  | "AUTH_CONFIG_BOUNDS"
  | "AUTH_CONFIG_UNSUPPORTED_REF"

type StartupStrategy = "api-key" | "plugin" | "jwt" | "oidc" | "oauth2" | "spiffe"

type ValidatorContext = {
  config: Config.Info
  getEnv: (key: string) => string | undefined
  getApiKey: () => string | undefined
  hasExternalHttpHook: () => Promise<boolean>
}

const SUPPORTED_STRATEGIES = new Set<StartupStrategy>(["api-key", "plugin", "jwt", "oidc", "oauth2", "spiffe"])
const SUPPORTED_INTROSPECTION_AUTH_METHODS = new Set([
  "client_secret_basic",
  "client_secret_post",
  "bearer_client_credentials",
])
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])
const OIDC_MULTI_ALLOWED_KEYS = new Set(["issuer", "audience"])

function normalizeToolEndpointAuth(raw: unknown): string[] {
  if (raw === undefined) return ["api-key"]
  if (Array.isArray(raw)) return raw
  return [raw as string]
}

function parseList(input: string | undefined) {
  if (!input) return []
  return input
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function normalizeIssuer(input: string) {
  return input.endsWith("/") ? input.slice(0, -1) : input
}

function parseURL(input: string) {
  try {
    return new URL(input)
  } catch {
    return
  }
}

// ---------------------------------------------------------------------------
// plugin authz startup validation
// ---------------------------------------------------------------------------

function validatePluginAuthzConfig(config: Config.Info) {
  const pluginAuthzConfigs: Array<{ path: string; config: any }> = []

  // Server-level plugin authz
  const serverAuthz = (config.server?.a2a as any)?.authz
  if (serverAuthz?.provider === "plugin") {
    pluginAuthzConfigs.push({ path: "server.a2a.authz.plugin", config: serverAuthz.plugin })
  }

  // Per-agent plugin authz
  if (config.agent) {
    for (const [agentName, agentConfig] of Object.entries(config.agent)) {
      const agentAuthz = ((agentConfig as any)?.a2a as any)?.authz
      if (agentAuthz?.provider === "plugin") {
        pluginAuthzConfigs.push({ path: `agent.${agentName}.a2a.authz.plugin`, config: agentAuthz.plugin })
      }
    }
  }

  for (const { path, config: pConfig } of pluginAuthzConfigs) {
    if (!pConfig || typeof pConfig !== "object" || Array.isArray(pConfig)) {
      fail({
        code: "AUTH_CONFIG_MISSING",
        strategy: "plugin",
        key: path,
        reason: "required",
      })
    }
    if (typeof pConfig.id !== "string" || !pConfig.id.trim()) {
      fail({
        code: "AUTH_CONFIG_MISSING",
        strategy: "plugin",
        key: `${path}.id`,
        reason: "required",
      })
    }
    if (!pConfig.policy || typeof pConfig.policy !== "object" || Array.isArray(pConfig.policy)) {
      fail({
        code: "AUTH_CONFIG_MISSING",
        strategy: "plugin",
        key: `${path}.policy`,
        reason: "required",
      })
    }
  }
}


function isExactLoopback(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
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
  const raw = getEnv("OPENCODE_USER_JWT_CLOCK_SKEW_SECONDS")
  if (!raw) return
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 300) {
    fail({
      code: "AUTH_CONFIG_BOUNDS",
      strategy: "global",
      key: "env.OPENCODE_USER_JWT_CLOCK_SKEW_SECONDS",
      reason: "must_be_integer_between_0_and_300",
    })
  }
}

function validateIntrospectionTimeoutBounds(getEnv: ValidatorContext["getEnv"]) {
  const raw = getEnv("OPENCODE_OAUTH_INTROSPECTION_TIMEOUT_MS")
  if (!raw) return
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 120000) {
    fail({
      code: "AUTH_CONFIG_BOUNDS",
      strategy: "oauth2",
      key: "env.OPENCODE_OAUTH_INTROSPECTION_TIMEOUT_MS",
      reason: "must_be_integer_between_1_and_120000",
    })
  }
}

function validateIntrospectionStaleBounds(getEnv: ValidatorContext["getEnv"]) {
  const staleWhileErrorRaw = getEnv("OPENCODE_OAUTH_INTROSPECTION_STALE_WHILE_ERROR_MS")
  if (staleWhileErrorRaw !== undefined) {
    const parsed = Number(staleWhileErrorRaw)
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 60000) {
      fail({
        code: "AUTH_CONFIG_BOUNDS",
        strategy: "oauth2",
        key: "env.OPENCODE_OAUTH_INTROSPECTION_STALE_WHILE_ERROR_MS",
        reason: "must_be_integer_between_0_and_60000",
      })
    }
  }

  const staleMaxAbsAgeRaw = getEnv("OPENCODE_OAUTH_INTROSPECTION_STALE_MAX_ABS_AGE_MS")
  if (staleMaxAbsAgeRaw !== undefined) {
    const parsed = Number(staleMaxAbsAgeRaw)
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 60000) {
      fail({
        code: "AUTH_CONFIG_BOUNDS",
        strategy: "oauth2",
        key: "env.OPENCODE_OAUTH_INTROSPECTION_STALE_MAX_ABS_AGE_MS",
        reason: "must_be_integer_between_0_and_60000",
      })
    }
  }
}

function validateIntrospectionStaleRequireExpLiteral(getEnv: ValidatorContext["getEnv"]) {
  const raw = getEnv("OPENCODE_OAUTH_INTROSPECTION_STALE_REQUIRE_EXP")
  if (raw === undefined) return
  const normalized = raw.trim().toLowerCase()
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") return
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") return
  fail({
    code: "AUTH_CONFIG_BOUNDS",
    strategy: "oauth2",
    key: "env.OPENCODE_OAUTH_INTROSPECTION_STALE_REQUIRE_EXP",
    reason: "must_be_boolean_literal",
  })
}

function validateJWTConfig(getEnv: ValidatorContext["getEnv"]) {
  const jwks = getEnv("OPENCODE_USER_JWT_JWKS_URL")
  const hs256 = getEnv("OPENCODE_USER_JWT_HS256_SECRET")
  if (hs256) {
    fail({
      code: "AUTH_CONFIG_UNSUPPORTED_REF",
      strategy: "jwt",
      key: "env.OPENCODE_USER_JWT_HS256_SECRET",
      reason: "hs256_deprecated_use_jwks",
    })
  }
  if (!jwks) {
    fail({
      code: "AUTH_CONFIG_MISSING",
      strategy: "jwt",
      key: "env.OPENCODE_USER_JWT_JWKS_URL",
      reason: "required",
    })
  }
  if (jwks) {
    validateAuthURL("jwt", "env.OPENCODE_USER_JWT_JWKS_URL", jwks)
  }
}

function validateOIDCConfig(getEnv: ValidatorContext["getEnv"]) {
  const issuer = getEnv("OPENCODE_OIDC_ISSUER")
  const issuersJSON = getEnv("OPENCODE_OIDC_ISSUERS_JSON")

  if (issuer && issuersJSON) {
    fail({
      code: "AUTH_CONFIG_CONFLICT",
      strategy: "oidc",
      key: "env.OPENCODE_OIDC_ISSUER|env.OPENCODE_OIDC_ISSUERS_JSON",
      reason: "mutually_exclusive_issuer_sources",
    })
  }

  if (issuersJSON) {
    let parsed: unknown
    try {
      parsed = JSON.parse(issuersJSON)
    } catch {
      fail({
        code: "AUTH_CONFIG_UNSUPPORTED_REF",
        strategy: "oidc",
        key: "env.OPENCODE_OIDC_ISSUERS_JSON",
        reason: "invalid_json",
      })
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      fail({
        code: "AUTH_CONFIG_UNSUPPORTED_REF",
        strategy: "oidc",
        key: "env.OPENCODE_OIDC_ISSUERS_JSON",
        reason: "must_be_non_empty_array",
      })
    }

    const seen = new Set<string>()
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        fail({
          code: "AUTH_CONFIG_UNSUPPORTED_REF",
          strategy: "oidc",
          key: "env.OPENCODE_OIDC_ISSUERS_JSON",
          reason: "entry_must_be_object",
        })
      }

      const record = entry as Record<string, unknown>
      for (const key of Object.keys(record)) {
        if (!OIDC_MULTI_ALLOWED_KEYS.has(key)) {
          fail({
            code: "AUTH_CONFIG_UNSUPPORTED_REF",
            strategy: "oidc",
            key: "env.OPENCODE_OIDC_ISSUERS_JSON",
            reason: "unknown_entry_keys",
          })
        }
      }

      if (typeof record.issuer !== "string" || !record.issuer.trim()) {
        fail({
          code: "AUTH_CONFIG_UNSUPPORTED_REF",
          strategy: "oidc",
          key: "env.OPENCODE_OIDC_ISSUERS_JSON",
          reason: "issuer_required",
        })
      }
      const normalized = normalizeIssuer(record.issuer.trim())
      validateAuthURL("oidc", "env.OPENCODE_OIDC_ISSUERS_JSON", normalized)
      if (seen.has(normalized)) {
        fail({
          code: "AUTH_CONFIG_CONFLICT",
          strategy: "oidc",
          key: "env.OPENCODE_OIDC_ISSUERS_JSON",
          reason: "duplicate_normalized_issuers",
        })
      }
      seen.add(normalized)

      if (record.audience !== undefined) {
        const audience = record.audience
        const valid =
          typeof audience === "string" ||
          (Array.isArray(audience) && audience.length > 0 && audience.every((value) => typeof value === "string"))
        if (!valid) {
          fail({
            code: "AUTH_CONFIG_UNSUPPORTED_REF",
            strategy: "oidc",
            key: "env.OPENCODE_OIDC_ISSUERS_JSON",
            reason: "invalid_audience_shape",
          })
        }
      }
    }

    const allowedAlgs = parseList(getEnv("OPENCODE_OIDC_ALGS"))
    if (allowedAlgs.some((alg) => alg.toLowerCase() === "none")) {
      fail({
        code: "AUTH_CONFIG_UNSUPPORTED_REF",
        strategy: "oidc",
        key: "env.OPENCODE_OIDC_ALGS",
        reason: "alg_none_disallowed",
      })
    }
    if (allowedAlgs.some((alg) => alg !== "RS256")) {
      fail({
        code: "AUTH_CONFIG_UNSUPPORTED_REF",
        strategy: "oidc",
        key: "env.OPENCODE_OIDC_ALGS",
        reason: "only_rs256_supported",
      })
    }
    return
  }

  if (!issuer) {
    fail({
      code: "AUTH_CONFIG_MISSING",
      strategy: "oidc",
      key: "env.OPENCODE_OIDC_ISSUER",
      reason: "required",
    })
  }
  validateAuthURL("oidc", "env.OPENCODE_OIDC_ISSUER", issuer)

  const allowedAlgs = parseList(getEnv("OPENCODE_OIDC_ALGS"))
  if (allowedAlgs.some((alg) => alg.toLowerCase() === "none")) {
    fail({
      code: "AUTH_CONFIG_UNSUPPORTED_REF",
      strategy: "oidc",
      key: "env.OPENCODE_OIDC_ALGS",
      reason: "alg_none_disallowed",
    })
  }
  if (allowedAlgs.some((alg) => alg !== "RS256")) {
    fail({
      code: "AUTH_CONFIG_UNSUPPORTED_REF",
      strategy: "oidc",
      key: "env.OPENCODE_OIDC_ALGS",
      reason: "only_rs256_supported",
    })
  }
}

function validateOAuth2Config(getEnv: ValidatorContext["getEnv"]) {
  const introspectionURL = getEnv("OPENCODE_OAUTH_INTROSPECTION_URL")
  const clientID = getEnv("OPENCODE_OAUTH_CLIENT_ID")
  const clientSecret = getEnv("OPENCODE_OAUTH_CLIENT_SECRET")

  if (!introspectionURL) {
    fail({
      code: "AUTH_CONFIG_MISSING",
      strategy: "oauth2",
      key: "env.OPENCODE_OAUTH_INTROSPECTION_URL",
      reason: "required",
    })
  }
  if (!clientID) {
    fail({
      code: "AUTH_CONFIG_MISSING",
      strategy: "oauth2",
      key: "env.OPENCODE_OAUTH_CLIENT_ID",
      reason: "required",
    })
  }
  if (!clientSecret) {
    fail({
      code: "AUTH_CONFIG_MISSING",
      strategy: "oauth2",
      key: "env.OPENCODE_OAUTH_CLIENT_SECRET",
      reason: "required",
    })
  }

  validateAuthURL("oauth2", "env.OPENCODE_OAUTH_INTROSPECTION_URL", introspectionURL)
  validateIntrospectionTimeoutBounds(getEnv)
  validateIntrospectionStaleBounds(getEnv)
  validateIntrospectionStaleRequireExpLiteral(getEnv)

  const authMethod = getEnv("OPENCODE_OAUTH_INTROSPECTION_AUTH_METHOD") ?? "client_secret_basic"
  if (!SUPPORTED_INTROSPECTION_AUTH_METHODS.has(authMethod)) {
    fail({
      code: "AUTH_CONFIG_UNSUPPORTED_REF",
      strategy: "oauth2",
      key: "env.OPENCODE_OAUTH_INTROSPECTION_AUTH_METHOD",
      reason: "unsupported_auth_method",
    })
  }

  const explicitTokenURL = getEnv("OPENCODE_OAUTH_INTROSPECTION_TOKEN_URL")
  if (explicitTokenURL) {
    validateAuthURL("oauth2", "env.OPENCODE_OAUTH_INTROSPECTION_TOKEN_URL", explicitTokenURL)
  }
}

export async function validateStartupAuthConfig(context: ValidatorContext) {
  const endpoint = context.config.server?.toolEndpoint
  if (!endpoint?.enabled) return

  const strategies = normalizeToolEndpointAuth(endpoint.auth)
  if (strategies.length === 0) {
    fail({
      code: "AUTH_CONFIG_MISSING",
      strategy: "unknown",
      key: "server.toolEndpoint.auth",
      reason: "empty_strategy_list",
    })
  }

  const seen = new Set<string>()
  for (const strategy of strategies) {
    if (seen.has(strategy)) {
      fail({
        code: "AUTH_CONFIG_CONFLICT",
        strategy,
        key: "server.toolEndpoint.auth",
        reason: "duplicate_strategy",
      })
    }
    seen.add(strategy)

    if (!SUPPORTED_STRATEGIES.has(strategy as StartupStrategy)) {
      fail({
        code: "AUTH_CONFIG_UNSUPPORTED_REF",
        strategy: "unknown",
        key: "server.toolEndpoint.auth",
        reason: "unsupported_strategy_reference",
      })
    }
  }

  validateClockSkewBounds(context.getEnv)

  for (const strategy of strategies) {
    switch (strategy as StartupStrategy) {
      case "api-key": {
        if (!context.getApiKey()) {
          fail({
            code: "AUTH_CONFIG_MISSING",
            strategy: "api-key",
            key: "env.OPENCODE_TOOL_ENDPOINT_API_KEY",
            reason: "required",
          })
        }
        break
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
        break
      }
      case "jwt": {
        validateJWTConfig(context.getEnv)
        break
      }
      case "oidc": {
        validateOIDCConfig(context.getEnv)
        break
      }
      case "oauth2": {
        validateOAuth2Config(context.getEnv)
        break
      }
      case "spiffe": {
        const endpoint = context.getEnv("SPIFFE_ENDPOINT_SOCKET")
        if (!endpoint) {
          fail({
            code: "AUTH_CONFIG_MISSING",
            strategy: "spiffe",
            key: "env.SPIFFE_ENDPOINT_SOCKET",
            reason: "required",
          })
        }
        const audience = context.getEnv("OPENCODE_SPIFFE_AUDIENCE")
        if (!audience) {
          fail({
            code: "AUTH_CONFIG_MISSING",
            strategy: "spiffe",
            key: "env.OPENCODE_SPIFFE_AUDIENCE",
            reason: "required",
          })
        }
        break
      }
    }
  }

  // Validate ext_authz config (server-level)
  validateExtAuthzConfig(context.config)
  validatePluginAuthzConfig(context.config)

  // Validate A2A api-key auth config
  validateA2AAuthStrategies(context)
  validateA2AApiKeyConfig(context)
}

function normalizeA2AAuth(raw: unknown): string[] {
  if (raw === undefined) return []
  if (Array.isArray(raw)) return raw
  return [raw as string]
}

const SUPPORTED_A2A_AUTH_STRATEGIES = new Set(["api-key", "jwt", "oidc", "oauth2", "spiffe"])

function validateA2AAuthStrategies(context: ValidatorContext) {
  const a2a = context.config.server?.a2a
  if (!a2a?.enabled) return

  const check = (path: string, auth: string[]) => {
    const seen = new Set<string>()
    for (const strategy of auth) {
      if (seen.has(strategy)) {
        fail({
          code: "AUTH_CONFIG_CONFLICT",
          strategy,
          key: path,
          reason: "duplicate_strategy",
        })
      }
      seen.add(strategy)
      if (strategy === "plugin") {
        fail({
          code: "AUTH_CONFIG_UNSUPPORTED_REF",
          strategy,
          key: path,
          reason: "plugin_not_allowed_in_a2a_auth",
        })
      }
      if (!SUPPORTED_A2A_AUTH_STRATEGIES.has(strategy)) {
        fail({
          code: "AUTH_CONFIG_UNSUPPORTED_REF",
          strategy: "unknown",
          key: path,
          reason: "unsupported_strategy_reference",
        })
      }
    }
  }

  check("server.a2a.auth", normalizeA2AAuth((a2a as any).auth))
  if (!context.config.agent) return
  for (const [agentName, agentConfig] of Object.entries(context.config.agent)) {
    const auth = normalizeA2AAuth(((agentConfig as any)?.a2a as any)?.auth)
    check(`agent.${agentName}.a2a.auth`, auth)
  }
}

function validateA2AApiKeyConfig(context: ValidatorContext) {
  const a2a = context.config.server?.a2a
  if (!a2a?.enabled) return

  // Check server-level A2A auth
  const serverAuth = normalizeA2AAuth((a2a as any).auth)
  if (serverAuth.includes("api-key")) {
    if (!context.getEnv("OPENCODE_A2A_API_KEY")) {
      fail({
        code: "AUTH_CONFIG_MISSING",
        strategy: "api-key",
        key: "env.OPENCODE_A2A_API_KEY",
        reason: "required",
      })
    }
  }

  // Check per-agent A2A auth
  if (context.config.agent) {
    for (const [agentName, agentConfig] of Object.entries(context.config.agent)) {
      const agentA2A = (agentConfig as any)?.a2a
      if (!agentA2A) continue
      const agentAuth = normalizeA2AAuth(agentA2A.auth)
      if (agentAuth.includes("api-key")) {
        if (!context.getEnv("OPENCODE_A2A_API_KEY")) {
          fail({
            code: "AUTH_CONFIG_MISSING",
            strategy: "api-key",
            key: "env.OPENCODE_A2A_API_KEY",
            reason: "required",
          })
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// ext_authz startup validation
// ---------------------------------------------------------------------------

function validateExtAuthzConfig(config: Config.Info) {
  const extAuthzConfigs: Array<{ path: string; config: any }> = []

  // Server-level ext_authz
  const serverExtAuthz = (config.server?.a2a as any)?.authz?.extAuthz
  if (serverExtAuthz) {
    extAuthzConfigs.push({ path: "server.a2a.authz.extAuthz", config: serverExtAuthz })
  }

  // Per-agent ext_authz
  if (config.agent) {
    for (const [agentName, agentConfig] of Object.entries(config.agent)) {
      const agentExtAuthz = ((agentConfig as any)?.a2a as any)?.authz?.extAuthz
      if (agentExtAuthz) {
        extAuthzConfigs.push({ path: `agent.${agentName}.a2a.authz.extAuthz`, config: agentExtAuthz })
      }
    }
  }

  for (const { path, config: extConfig } of extAuthzConfigs) {
    // endpoint is required
    if (!extConfig.endpoint || typeof extConfig.endpoint !== "string") {
      fail({
        code: "AUTH_CONFIG_MISSING",
        strategy: "ext_authz" as any,
        key: `${path}.endpoint`,
        reason: "required",
      })
    }

    // Validate endpoint format
    const endpoint = extConfig.endpoint as string
    if (!endpoint.startsWith("grpc://") && !endpoint.startsWith("dns:///") && !endpoint.includes(":")) {
      fail({
        code: "AUTH_CONFIG_INVALID_URL",
        strategy: "ext_authz" as any,
        key: `${path}.endpoint`,
        reason: "invalid_endpoint_format",
      })
    }

    // Validate timeout bounds (if specified as number)
    const timeout = extConfig.timeout
    if (typeof timeout === "number") {
      if (timeout < 10 || timeout > 30000) {
        fail({
          code: "AUTH_CONFIG_BOUNDS",
          strategy: "ext_authz" as any,
          key: `${path}.timeout`,
          reason: "timeout_out_of_range_10_30000ms",
        })
      }
    } else if (typeof timeout === "string") {
      // Parse "500ms" or "2s" format
      const match = timeout.match(/^(\d+)(ms|s)$/)
      if (!match) {
        fail({
          code: "AUTH_CONFIG_INVALID_URL",
          strategy: "ext_authz" as any,
          key: `${path}.timeout`,
          reason: "invalid_timeout_format",
        })
      }
    }

    // Validate withRequestBody.maxBytes bounds
    if (extConfig.withRequestBody?.maxBytes !== undefined) {
      const maxBytes = extConfig.withRequestBody.maxBytes
      if (typeof maxBytes !== "number" || maxBytes < 0 || maxBytes > 1024 * 1024) {
        fail({
          code: "AUTH_CONFIG_BOUNDS",
          strategy: "ext_authz" as any,
          key: `${path}.withRequestBody.maxBytes`,
          reason: "max_bytes_out_of_range_0_1MB",
        })
      }
    }
  }
}
