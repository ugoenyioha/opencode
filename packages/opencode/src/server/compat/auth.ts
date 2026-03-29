import { anthropicError, openAIError } from "./error"
import { Env } from "@/env"
import { timingSafeEqual } from "crypto"
import { createHash } from "crypto"
import { createPublicKey } from "crypto"
import { createVerify } from "crypto"
import {
  emitAuthDecision,
  emitAuthVerifierWarn,
  type AuthReason,
  type AuthRoute,
  type AuthSource,
  type AuthStrategyLabel,
  type AuthSurface,
} from "../auth-observability"

type AuthObserveContext = {
  surface: AuthSurface
  route: AuthRoute
  source: AuthSource
}

const OPENAI_COMPAT_CONTEXT: AuthObserveContext = {
  surface: "openai",
  route: "openai.compat",
  source: "compat",
}

function verifierWarn(
  strategy: AuthStrategyLabel,
  reason: Extract<AuthReason, "jwt_verifier_error" | "oidc_discovery_error" | "oauth_introspection_error" | "verifier_internal_error">,
  context: AuthObserveContext,
) {
  emitAuthVerifierWarn({
    surface: context.surface,
    route: context.route,
    strategy,
    reason,
  })
}

function bearer(input: string | undefined) {
  if (!input) return
  const [scheme, ...rest] = input.split(" ")
  if (scheme.toLowerCase() !== "bearer") return
  const token = rest.join(" ").trim()
  if (!token) return
  return token
}

export type StrictBearerStrategy = "jwt" | "oidc" | "oauth2"

export function bearerFromHeaders(headers: Headers) {
  return bearer(headers.get("authorization") ?? undefined)
}

function parseBase64urlJSON(input: string) {
  try {
    const normalized = input.replace(/-/g, "+").replace(/_/g, "/")
    const padding = normalized.length % 4
    const withPadding = padding === 0 ? normalized : normalized + "=".repeat(4 - padding)
    return JSON.parse(Buffer.from(withPadding, "base64").toString("utf8")) as Record<string, unknown>
  } catch {
    return
  }
}

function decodeBase64url(input: string) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/")
  const padding = normalized.length % 4
  const withPadding = padding === 0 ? normalized : normalized + "=".repeat(4 - padding)
  return Buffer.from(withPadding, "base64")
}

type JWTHeader = {
  alg?: string
  kid?: string
}

type JWTPayload = {
  sub?: string
  exp?: number
  nbf?: number
  iss?: string
  aud?: string | string[]
}

/**
 * Returned by verifyBearerForStrategy on success.
 * Carries the `sub` claim from the verified JWT or introspection response,
 * enabling callers to thread the authenticated principal identity through
 * to ext_authz and audit logs.
 */
export type VerifiedToken = {
  /** The `sub` claim from the token, if present. */
  sub?: string
  cnf?: unknown
}

type JWTVerifyOptions = {
  issuer?: string
  audience?: string | string[] | null
}

type IntrospectionResponse = {
  active?: boolean
  sub?: string
  exp?: number
  nbf?: number
  iss?: string
  aud?: string | string[]
  scope?: string | string[]
}

type OAuthTokenResponse = {
  access_token?: string
  expires_in?: number
}

type IntrospectionBearerTokenResult =
  | { kind: "ok"; token: string }
  | { kind: "outage" }
  | { kind: "explicit_deny" }

type ParsedJWT = {
  header: JWTHeader
  payload: JWTPayload
  signingInput: string
  signature: Buffer
}

function parseJWT(token: string): ParsedJWT | undefined {
  const [encodedHeader, encodedPayload, encodedSignature, ...rest] = token.split(".")
  if (rest.length || !encodedHeader || !encodedPayload || !encodedSignature) return
  const header = parseBase64urlJSON(encodedHeader) as JWTHeader | undefined
  const payload = parseBase64urlJSON(encodedPayload) as JWTPayload | undefined
  if (!header || !payload) return
  return {
    header,
    payload,
    signingInput: `${encodedHeader}.${encodedPayload}`,
    signature: decodeBase64url(encodedSignature),
  }
}

function isLikelyJWT(token: string) {
  const parts = token.split(".")
  if (parts.length !== 3) return false
  return parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))
}

function parseList(input: string | undefined) {
  if (!input) return []
  return input
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function parseAudience(input: unknown): string[] {
  if (typeof input === "string") return [input]
  if (!Array.isArray(input)) return []
  return input.filter((value): value is string => typeof value === "string")
}

function hasRequiredAnyScope(required: string[], granted: string[]) {
  if (!required.length) return true
  if (!granted.length) return false
  const grantedSet = new Set(granted)
  return required.some((scope) => grantedSet.has(scope))
}

function claimChecksWithExpected(
  payload: JWTPayload,
  expectedIssuer?: string,
  expectedAudience?: string | string[],
  options?: { normalizeIssuerMatch?: boolean },
) {
  const now = Math.floor(Date.now() / 1000)
  const skew = Number(Env.get("OPENCODE_COMPAT_JWT_CLOCK_SKEW_SECONDS")) || JWT_CLOCK_SKEW_SECONDS
  const exp = payload.exp
  if (typeof exp === "number" && now >= exp + skew) return false
  const nbf = payload.nbf
  if (typeof nbf === "number" && now < nbf - skew) return false

  if (expectedIssuer) {
    if (options?.normalizeIssuerMatch) {
      if (typeof payload.iss !== "string") return false
      if (normalizeIssuer(payload.iss) !== normalizeIssuer(expectedIssuer)) return false
    } else if (payload.iss !== expectedIssuer) {
      return false
    }
  }
  if (expectedAudience) {
    const expected = Array.isArray(expectedAudience) ? expectedAudience : [expectedAudience]
    const audiences = parseAudience(payload.aud)
    if (!expected.some((value) => audiences.includes(value))) return false
  }
  return true
}

type JWKSet = {
  keys?: Array<Record<string, unknown>>
}

const jwksCache = new Map<string, { expiresAt: number; keys: Array<Record<string, unknown>> }>()
const JWKS_TTL_MS = 60_000
const JWKS_ERROR_TTL_MS = 10_000
const JWKS_FETCH_TIMEOUT_MS = 5_000
const JWT_CLOCK_SKEW_SECONDS = 30

async function loadJWKS(url: string, context: AuthObserveContext) {
  const cached = jwksCache.get(url)
  const now = Date.now()
  if (cached && cached.expiresAt > now) return cached.keys

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS) })
    if (!response.ok) {
      jwksCache.set(url, { expiresAt: now + JWKS_ERROR_TTL_MS, keys: [] })
      return []
    }
    const data = (await response.json()) as JWKSet
    const keys = Array.isArray(data.keys) ? data.keys : []
    jwksCache.set(url, { expiresAt: now + JWKS_TTL_MS, keys })
    return keys
  } catch {
    verifierWarn("jwt", "jwt_verifier_error", context)
    jwksCache.set(url, { expiresAt: now + JWKS_ERROR_TTL_MS, keys: [] })
    return []
  }
}

async function verifyRS256Signature(parsed: ParsedJWT, jwksURL: string, context: AuthObserveContext) {
  if (parsed.header.alg !== "RS256") return false
  if (!parsed.header.kid) return false

  const keys = await loadJWKS(jwksURL, context)
  const jwk = keys.find((key) => key.kid === parsed.header.kid && key.kty === "RSA")
  if (!jwk) return false

  try {
    const publicKey = createPublicKey({ key: jwk, format: "jwk" })
    const verifier = createVerify("RSA-SHA256")
    verifier.update(parsed.signingInput)
    verifier.end()
    return verifier.verify(publicKey, parsed.signature)
  } catch {
    return false
  }
}

async function verifyRS256JWT(
  parsed: ParsedJWT,
  jwksURL: string,
  context: AuthObserveContext,
  options?: JWTVerifyOptions,
): Promise<VerifiedToken | false> {
  const signatureOk = await verifyRS256Signature(parsed, jwksURL, context)
  if (!signatureOk) return false
  const issuer = options?.issuer ?? Env.get("OPENCODE_COMPAT_JWT_ISSUER")
  const audience =
    options?.audience === null
      ? undefined
      : options?.audience ?? (() => {
          const values = parseList(Env.get("OPENCODE_COMPAT_JWT_AUDIENCE"))
          return values.length ? values : undefined
        })()
  if (!claimChecksWithExpected(parsed.payload, issuer, audience)) return false
  // Return the full JWT payload so authz plugins (e.g., Cedar) can evaluate
  // rich claims like authorization_details, act, act_depth, step_up_verified.
  return parsed.payload as Record<string, unknown>
}

type OIDCDiscovery = {
  issuer?: string
  jwks_uri?: string
}

type OIDCMultiIssuerEntry = {
  issuer: string
  audience?: string[]
}

type OIDCMultiIssuerParseResult =
  | { mode: "absent" }
  | { mode: "invalid" }
  | { mode: "valid"; issuers: Map<string, OIDCMultiIssuerEntry> }

type OIDCMultiVerifyResult = {
  ok: boolean
  issuerMatched: boolean
}

const oidcDiscoveryCache = new Map<string, { expiresAt: number; data?: OIDCDiscovery }>()
const OIDC_DISCOVERY_TTL_MS = 60_000
const OIDC_DISCOVERY_RETRIES = 2
const OIDC_DISCOVERY_RETRY_DELAY_MS = 150
const OIDC_DISCOVERY_STALE_ON_ERROR_TTL_MS = 30_000
const INTROSPECTION_CACHE_MAX_ENTRIES = 2048

function toURL(input: string) {
  try {
    return new URL(input)
  } catch {
    return
  }
}

function isLoopbackHost(hostname: string) {
  const normalized = hostname.trim().toLowerCase()
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1"
}

function isAllowedAuthURL(url: URL) {
  const scheme = url.protocol.toLowerCase()
  if (scheme === "https:") return true
  if (scheme === "http:" && isLoopbackHost(url.hostname)) return true
  return false
}

function enforceAuthURLPolicy(input: string) {
  const url = toURL(input)
  if (!url) return
  if (!isAllowedAuthURL(url)) return
  return url
}

function normalizeIssuer(issuer: string) {
  return issuer.endsWith("/") ? issuer.slice(0, -1) : issuer
}

function parseOIDCMultiIssuersJSON(raw: string | undefined): OIDCMultiIssuerParseResult {
  if (raw === undefined) return { mode: "absent" }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { mode: "invalid" }
  }

  if (!Array.isArray(parsed) || parsed.length === 0) return { mode: "invalid" }

  const issuers = new Map<string, OIDCMultiIssuerEntry>()
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { mode: "invalid" }
    const record = item as Record<string, unknown>
    for (const key of Object.keys(record)) {
      if (key !== "issuer" && key !== "audience") return { mode: "invalid" }
    }

    if (typeof record.issuer !== "string") return { mode: "invalid" }
    const issuer = record.issuer.trim()
    if (!issuer) return { mode: "invalid" }
    const normalizedIssuer = normalizeIssuer(issuer)

    let audience: string[] | undefined
    if (record.audience !== undefined) {
      if (typeof record.audience === "string") {
        audience = [record.audience]
      } else if (Array.isArray(record.audience) && record.audience.length > 0) {
        if (!record.audience.every((value) => typeof value === "string")) return { mode: "invalid" }
        audience = record.audience
      } else {
        return { mode: "invalid" }
      }
    }

    if (issuers.has(normalizedIssuer)) return { mode: "invalid" }
    issuers.set(normalizedIssuer, {
      issuer: normalizedIssuer,
      audience,
    })
  }

  return { mode: "valid", issuers }
}

function trimIssuerPath(input: string) {
  const parsed = toURL(input)
  if (!parsed) return input
  parsed.pathname = parsed.pathname.replace(/\/$/, "")
  parsed.search = ""
  parsed.hash = ""
  return parsed.toString().replace(/\/$/, "")
}

function introspectionCacheSet(key: string, value: { expiresAt: number; allowed: boolean; sub?: string; verifiedAt?: number; expMs?: number }) {
  introspectionCache.set(key, value)
  if (introspectionCache.size <= INTROSPECTION_CACHE_MAX_ENTRIES) return

  const now = Date.now()
  for (const [cacheKey, entry] of introspectionCache) {
    if (entry.expiresAt <= now) introspectionCache.delete(cacheKey)
  }
  if (introspectionCache.size <= INTROSPECTION_CACHE_MAX_ENTRIES) return

  while (introspectionCache.size > INTROSPECTION_CACHE_MAX_ENTRIES) {
    const oldest = introspectionCache.keys().next().value
    if (!oldest) break
    introspectionCache.delete(oldest)
  }
}

async function loadOIDCDiscovery(issuer: string, context: AuthObserveContext) {
  const cached = oidcDiscoveryCache.get(issuer)
  const now = Date.now()
  if (cached && cached.expiresAt > now) return cached.data
  const stale = cached?.data

  const normalizedIssuer = normalizeIssuer(issuer)
  const validatedIssuer = enforceAuthURLPolicy(normalizedIssuer)
  if (!validatedIssuer) {
    oidcDiscoveryCache.set(issuer, { expiresAt: now + JWKS_ERROR_TTL_MS })
    return
  }
  const discoveryUrl = `${normalizedIssuer}/.well-known/openid-configuration`
  for (let attempt = 0; attempt < OIDC_DISCOVERY_RETRIES; attempt++) {
    try {
      const response = await fetch(discoveryUrl, { signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS) })
      if (!response.ok) {
        if (attempt + 1 < OIDC_DISCOVERY_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, OIDC_DISCOVERY_RETRY_DELAY_MS))
          continue
        }
        break
      }
      const data = (await response.json()) as OIDCDiscovery
      if (!data?.jwks_uri) {
        if (attempt + 1 < OIDC_DISCOVERY_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, OIDC_DISCOVERY_RETRY_DELAY_MS))
          continue
        }
        break
      }
      const discoveredIssuer = typeof data.issuer === "string" ? trimIssuerPath(data.issuer) : undefined
      const expectedIssuer = trimIssuerPath(normalizedIssuer)
      if (discoveredIssuer && discoveredIssuer !== expectedIssuer) break
      const jwksURL = enforceAuthURLPolicy(data.jwks_uri)
      if (!jwksURL) break
      if (!isLoopbackHost(validatedIssuer.hostname) && jwksURL.hostname !== validatedIssuer.hostname) break
      const normalizedData: OIDCDiscovery = {
        issuer: data.issuer,
        jwks_uri: jwksURL.toString(),
      }
      oidcDiscoveryCache.set(issuer, { expiresAt: now + OIDC_DISCOVERY_TTL_MS, data: normalizedData })
      return normalizedData
    } catch {
      if (attempt + 1 < OIDC_DISCOVERY_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, OIDC_DISCOVERY_RETRY_DELAY_MS))
        continue
      }
    }
  }

  verifierWarn("oidc", "oidc_discovery_error", context)
  if (stale?.jwks_uri) {
    oidcDiscoveryCache.set(issuer, {
      expiresAt: now + OIDC_DISCOVERY_STALE_ON_ERROR_TTL_MS,
      data: stale,
    })
    return stale
  }
  oidcDiscoveryCache.set(issuer, { expiresAt: now + JWKS_ERROR_TTL_MS })
  return
}

function acceptedOIDCAlgs() {
  const allowedAlgs = parseList(Env.get("OPENCODE_COMPAT_OIDC_ALGS"))
  return allowedAlgs.length ? allowedAlgs : ["RS256"]
}

async function verifyOIDCJWTForIssuer(
  parsed: ParsedJWT,
  expectedIssuer: string,
  expectedAudience: string | string[] | undefined,
  context: AuthObserveContext,
  options?: { normalizeIssuerMatch?: boolean },
): Promise<VerifiedToken | false> {
  if (parsed.header.alg === "none") return false

  const acceptedAlgs = acceptedOIDCAlgs()
  const alg = parsed.header.alg ?? ""
  if (!acceptedAlgs.includes(alg)) return false
  if (alg !== "RS256") return false

  const discovery = await loadOIDCDiscovery(expectedIssuer, context)
  const jwksUrl = discovery?.jwks_uri
  if (!jwksUrl) return false
  const signatureOk = await verifyRS256Signature(parsed, jwksUrl, context)
  if (!signatureOk) return false

  if (!claimChecksWithExpected(parsed.payload, expectedIssuer, expectedAudience, options)) return false
  return { sub: parsed.payload.sub, cnf: parsed.payload.cnf }
}

async function verifyOIDCJWT(token: string, context: AuthObserveContext): Promise<VerifiedToken | false> {
  const issuer = Env.get("OPENCODE_COMPAT_OIDC_ISSUER")
  if (!issuer) return false

  const parsed = parseJWT(token)
  if (!parsed) return false
  const audience = Env.get("OPENCODE_COMPAT_OIDC_AUDIENCE")
  return verifyOIDCJWTForIssuer(parsed, issuer, audience, context)
}

async function verifyOIDCMultiIssuerJWT(token: string, context: AuthObserveContext): Promise<OIDCMultiVerifyResult> {
  const parsedConfig = parseOIDCMultiIssuersJSON(Env.get("OPENCODE_COMPAT_OIDC_ISSUERS_JSON"))
  if (parsedConfig.mode !== "valid") {
    return { ok: false, issuerMatched: false }
  }

  const parsed = parseJWT(token)
  if (!parsed) return { ok: false, issuerMatched: false }
  if (typeof parsed.payload.iss !== "string") return { ok: false, issuerMatched: false }

  const issuerClaim = parsed.payload.iss.trim()
  if (!issuerClaim) return { ok: false, issuerMatched: false }
  const matched = parsedConfig.issuers.get(normalizeIssuer(issuerClaim))
  if (!matched) return { ok: false, issuerMatched: false }

  const result = await verifyOIDCJWTForIssuer(parsed, matched.issuer, matched.audience, context, {
    normalizeIssuerMatch: true,
  })
  return { ok: !!result, issuerMatched: true }
}

type IntrospectionCacheEntry = {
  expiresAt: number
  allowed: boolean
  sub?: string
  verifiedAt?: number
  expMs?: number
}

const introspectionCache = new Map<string, IntrospectionCacheEntry>()
const INTROSPECTION_SUCCESS_TTL_MS = 60_000
const introspectionAuthTokenCache = new Map<string, { expiresAt: number; token: string }>()

function introspectionConfigKey() {
  return [
    Env.get("OPENCODE_COMPAT_OAUTH_INTROSPECTION_URL") ?? "",
    Env.get("OPENCODE_COMPAT_OAUTH_CLIENT_ID") ?? "",
    Env.get("OPENCODE_COMPAT_OAUTH_REQUIRED_SCOPE") ?? "",
    Env.get("OPENCODE_COMPAT_OAUTH_ISSUER") ?? "",
    Env.get("OPENCODE_COMPAT_OAUTH_AUDIENCE") ?? "",
    Env.get("OPENCODE_COMPAT_OAUTH_INTROSPECTION_AUTH_METHOD") ?? "",
  ].join("|")
}

function introspectionAuthTokenCacheKey() {
  return [
    Env.get("OPENCODE_COMPAT_OAUTH_INTROSPECTION_URL") ?? "",
    Env.get("OPENCODE_COMPAT_OAUTH_CLIENT_ID") ?? "",
    Env.get("OPENCODE_COMPAT_OAUTH_INTROSPECTION_TOKEN_URL") ?? "",
    Env.get("OPENCODE_COMPAT_OAUTH_INTROSPECTION_BEARER_SCOPE") ?? "",
  ].join("|")
}

function introspectionCacheTokenKey(token: string) {
  return createHash("sha256").update(`${introspectionConfigKey()}|${token}`, "utf8").digest("hex")
}

function parseCompatBoolean(input: string | undefined, fallback: boolean) {
  if (input === undefined) return fallback
  const normalized = input.trim().toLowerCase()
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") return true
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") return false
  return fallback
}

function introspectionStaleWhileErrorMs() {
  const raw = Env.get("OPENCODE_COMPAT_OAUTH_INTROSPECTION_STALE_WHILE_ERROR_MS")
  if (raw === undefined) return 0
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0) return 0
  return parsed
}

function introspectionStaleRequireExp() {
  return parseCompatBoolean(Env.get("OPENCODE_COMPAT_OAUTH_INTROSPECTION_STALE_REQUIRE_EXP"), true)
}

function introspectionStaleMaxAbsAgeMs() {
  const raw = Env.get("OPENCODE_COMPAT_OAUTH_INTROSPECTION_STALE_MAX_ABS_AGE_MS")
  if (raw === undefined) return 30_000
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0) return 30_000
  return parsed
}

function clockSkewMs() {
  const skewSeconds = Number(Env.get("OPENCODE_COMPAT_JWT_CLOCK_SKEW_SECONDS")) || JWT_CLOCK_SKEW_SECONDS
  return Math.max(0, skewSeconds) * 1000
}

function canUseStaleIntrospectionAllow(params: {
  now: number
  cached?: IntrospectionCacheEntry
  staleWhileErrorMs: number
}): boolean {
  if (params.staleWhileErrorMs <= 0) return false
  const cached = params.cached
  if (!cached || !cached.allowed) return false
  if (typeof cached.verifiedAt !== "number") return false

  const staleMaxAbsAgeMs = introspectionStaleMaxAbsAgeMs()
  if (params.now - cached.verifiedAt > staleMaxAbsAgeMs) return false
  if (params.now > cached.expiresAt + params.staleWhileErrorMs) return false

  const requireExp = introspectionStaleRequireExp()
  if (typeof cached.expMs !== "number") return !requireExp
  if (params.now > cached.expMs + clockSkewMs()) return false
  return true
}

function introspectionEnabled() {
  return (
    !!Env.get("OPENCODE_COMPAT_OAUTH_INTROSPECTION_URL") &&
    !!Env.get("OPENCODE_COMPAT_OAUTH_CLIENT_ID") &&
    !!Env.get("OPENCODE_COMPAT_OAUTH_CLIENT_SECRET")
  )
}

function resolveIntrospectionTokenURL(endpointURL: URL) {
  const explicit = Env.get("OPENCODE_COMPAT_OAUTH_INTROSPECTION_TOKEN_URL")
  if (explicit) {
    const validated = enforceAuthURLPolicy(explicit)
    if (!validated) return
    return validated
  }

  const candidate = new URL(endpointURL.toString())
  if (candidate.pathname.endsWith("/introspect")) {
    candidate.pathname = candidate.pathname.replace(/\/introspect$/, "/token")
  } else {
    candidate.pathname = "/oauth2/token"
  }
  const validated = enforceAuthURLPolicy(candidate.toString())
  if (!validated) return
  return validated
}

async function loadIntrospectionBearerToken(
  endpointURL: URL,
  clientId: string,
  clientSecret: string,
  timeoutMs: number,
): Promise<IntrospectionBearerTokenResult> {
  const cacheKey = introspectionAuthTokenCacheKey()
  const cached = introspectionAuthTokenCache.get(cacheKey)
  const now = Date.now()
  if (cached && cached.expiresAt > now) return { kind: "ok", token: cached.token }

  const tokenURL = resolveIntrospectionTokenURL(endpointURL)
  if (!tokenURL) return { kind: "explicit_deny" }

  const scope = Env.get("OPENCODE_COMPAT_OAUTH_INTROSPECTION_BEARER_SCOPE") ?? "internal_oauth2_introspect"
  const tokenBody = new URLSearchParams({
    grant_type: "client_credentials",
    scope,
  })
  const credentials = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")
  try {
    const response = await fetch(tokenURL.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${credentials}`,
      },
      body: tokenBody.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      if (response.status >= 500) return { kind: "outage" }
      return { kind: "explicit_deny" }
    }
    const payload = (await response.json()) as OAuthTokenResponse
    if (!payload?.access_token) return { kind: "explicit_deny" }

    const ttlMs = Math.max(1000, ((payload.expires_in ?? 60) - 5) * 1000)
    introspectionAuthTokenCache.set(cacheKey, {
      token: payload.access_token,
      expiresAt: now + ttlMs,
    })
    return { kind: "ok", token: payload.access_token }
  } catch {
    return { kind: "outage" }
  }
}

function scopeFromIntrospection(value: IntrospectionResponse["scope"]): string[] {
  if (typeof value === "string") return parseList(value)
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

function verifyIntrospectionClaims(payload: IntrospectionResponse) {
  const now = Math.floor(Date.now() / 1000)
  const skew = Number(Env.get("OPENCODE_COMPAT_JWT_CLOCK_SKEW_SECONDS")) || JWT_CLOCK_SKEW_SECONDS
  if (typeof payload.exp === "number" && now >= payload.exp + skew) return false
  if (typeof payload.nbf === "number" && now < payload.nbf - skew) return false

  const expectedIssuer = Env.get("OPENCODE_COMPAT_OAUTH_ISSUER")
  if (expectedIssuer) {
    if (typeof payload.iss !== "string") return false
    if (payload.iss !== expectedIssuer) return false
  }

  const expectedAudience = Env.get("OPENCODE_COMPAT_OAUTH_AUDIENCE")
  if (expectedAudience) {
    const audiences = parseAudience(payload.aud)
    if (!audiences.length) return false
    if (!audiences.includes(expectedAudience)) return false
  }

  const requiredScopes = parseList(Env.get("OPENCODE_COMPAT_OAUTH_REQUIRED_SCOPE"))
  if (requiredScopes.length) {
    const tokenScopes = scopeFromIntrospection(payload.scope)
    if (!hasRequiredAnyScope(requiredScopes, tokenScopes)) return false
  }

  return true
}

async function verifyIntrospectionToken(token: string, context: AuthObserveContext): Promise<VerifiedToken | false> {
  if (!introspectionEnabled()) return false
  const key = introspectionCacheTokenKey(token)
  const now = Date.now()
  const cached = introspectionCache.get(key)
  if (cached && cached.expiresAt > now) return cached.allowed ? { sub: cached.sub } : false

  const staleWhileErrorMs = introspectionStaleWhileErrorMs()
  const useStaleAllow = () => canUseStaleIntrospectionAllow({ now: Date.now(), cached, staleWhileErrorMs })
  // On stale-allow paths, return the cached sub if we have one
  const staleResult = (): VerifiedToken => ({ sub: cached?.sub })

  const endpoint = Env.get("OPENCODE_COMPAT_OAUTH_INTROSPECTION_URL")!
  const clientId = Env.get("OPENCODE_COMPAT_OAUTH_CLIENT_ID")!
  const clientSecret = Env.get("OPENCODE_COMPAT_OAUTH_CLIENT_SECRET")!
  const authMethod = Env.get("OPENCODE_COMPAT_OAUTH_INTROSPECTION_AUTH_METHOD") ?? "client_secret_basic"
  const timeoutMs = Number(Env.get("OPENCODE_COMPAT_OAUTH_INTROSPECTION_TIMEOUT_MS")) || JWKS_FETCH_TIMEOUT_MS
  const endpointUrl = enforceAuthURLPolicy(endpoint)
  if (!endpointUrl) {
    introspectionCacheSet(key, { expiresAt: now + JWKS_ERROR_TTL_MS, allowed: false })
    return false
  }

  const body = new URLSearchParams({ token })
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  }

  if (authMethod === "client_secret_post") {
    body.set("client_id", clientId)
    body.set("client_secret", clientSecret)
  } else if (authMethod === "bearer_client_credentials") {
    const bearerTokenResult = await loadIntrospectionBearerToken(endpointUrl, clientId, clientSecret, timeoutMs)
    if (bearerTokenResult.kind !== "ok") {
      if (bearerTokenResult.kind === "outage" && useStaleAllow()) return staleResult()
      introspectionCacheSet(key, { expiresAt: now + JWKS_ERROR_TTL_MS, allowed: false })
      return false
    }
    headers.authorization = `Bearer ${bearerTokenResult.token}`
  } else {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")
    headers.authorization = `Basic ${credentials}`
  }

  try {
    const response = await fetch(endpointUrl.toString(), {
      method: "POST",
      headers,
      body: body.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      if (response.status >= 500 && useStaleAllow()) return staleResult()
      introspectionCacheSet(key, { expiresAt: now + JWKS_ERROR_TTL_MS, allowed: false })
      return false
    }

    const payload = (await response.json()) as IntrospectionResponse
    const active = payload?.active === true
    const allowed = active && verifyIntrospectionClaims(payload)
    if (!allowed) {
      introspectionCacheSet(key, { expiresAt: now + JWKS_ERROR_TTL_MS, allowed: false })
      return false
    }

    const sub = typeof payload.sub === "string" ? payload.sub : undefined
    const exp = typeof payload.exp === "number" ? payload.exp * 1000 : undefined
    const successExpiry = exp ? Math.min(exp, now + INTROSPECTION_SUCCESS_TTL_MS) : now + INTROSPECTION_SUCCESS_TTL_MS
    introspectionCacheSet(key, { expiresAt: successExpiry, allowed: true, sub, verifiedAt: now, expMs: exp })
    return { sub }
  } catch {
    verifierWarn("oauth2", "oauth_introspection_error", context)
    if (useStaleAllow()) return staleResult()
    introspectionCacheSet(key, { expiresAt: now + JWKS_ERROR_TTL_MS, allowed: false })
    return false
  }
}

async function verifyJWT(token: string, context: AuthObserveContext, options?: JWTVerifyOptions): Promise<VerifiedToken | false> {
  const parsed = parseJWT(token)
  if (!parsed) return false
  if (parsed.header.alg === "none") return false

  const jwksURL = Env.get("OPENCODE_COMPAT_JWT_JWKS_URL")

  if (parsed.header.alg === "RS256") {
    if (!jwksURL) return false
    const validatedJWKSURL = enforceAuthURLPolicy(jwksURL)
    if (!validatedJWKSURL) return false
    return verifyRS256JWT(parsed, validatedJWKSURL.toString(), context, options)
  }
  return false
}

export async function verifyBearerForStrategy(
  strategy: StrictBearerStrategy,
  token: string,
  context: AuthObserveContext = { surface: "server", route: "other", source: "centralized" },
  options?: {
    jwt?: JWTVerifyOptions
  },
): Promise<VerifiedToken | false> {
  try {
    if (strategy === "jwt") return verifyJWT(token, context, options?.jwt)
    if (strategy === "oidc") return verifyOIDCJWT(token, context)
    return verifyIntrospectionToken(token, context)
  } catch {
    verifierWarn(strategy, "verifier_internal_error", context)
    return false
  }
}

function bearerAuthEnabled() {
  return (
    !!Env.get("OPENCODE_COMPAT_JWT_JWKS_URL") ||
    !!Env.get("OPENCODE_COMPAT_OIDC_ISSUER") ||
    Env.get("OPENCODE_COMPAT_OIDC_ISSUERS_JSON") !== undefined ||
    introspectionEnabled()
  )
}

function allowJwtFallbackToIntrospection(multiOIDCMode: boolean) {
  const value = Env.get("OPENCODE_COMPAT_BEARER_FALLBACK_TO_INTROSPECTION")
  if (value === undefined) return multiOIDCMode ? false : true
  const normalized = value.trim().toLowerCase()
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on"
}

async function verifyBearerToken(token: string, context: AuthObserveContext): Promise<boolean> {
  const multiOIDCConfigured = Env.get("OPENCODE_COMPAT_OIDC_ISSUERS_JSON") !== undefined
  const oidcEnabled = !!Env.get("OPENCODE_COMPAT_OIDC_ISSUER") || multiOIDCConfigured
  const jwtEnabled = !!Env.get("OPENCODE_COMPAT_JWT_JWKS_URL")
  const introspectionOn = introspectionEnabled()

  const likelyJWT = isLikelyJWT(token)
  if (likelyJWT) {
    if (oidcEnabled) {
      if (multiOIDCConfigured) {
        const multiResult = await verifyOIDCMultiIssuerJWT(token, context)
        if (multiResult.ok) return true
        if (multiResult.issuerMatched && introspectionOn && allowJwtFallbackToIntrospection(true)) {
          return !!(await verifyIntrospectionToken(token, context))
        }
        return false
      }
      if (await verifyOIDCJWT(token, context)) return true
      if (introspectionOn && allowJwtFallbackToIntrospection(false)) return !!(await verifyIntrospectionToken(token, context))
      return false
    }
    if (jwtEnabled) {
      if (await verifyJWT(token, context)) return true
      if (introspectionOn && allowJwtFallbackToIntrospection(false)) return !!(await verifyIntrospectionToken(token, context))
      return false
    }
    if (introspectionOn) {
      return !!(await verifyIntrospectionToken(token, context))
    }
    return authorized(token)
  }

  if (introspectionOn) {
    return !!(await verifyIntrospectionToken(token, context))
  }
  if (oidcEnabled || jwtEnabled) {
    return false
  }
  return authorized(token)
}

function authorized(token: string) {
  const env = (key: string) => {
    const raw = process.env[key]
    if (raw !== undefined) return raw
    return Env.get(key)
  }

  const candidates = [env("OPENCODE_TOOL_ENDPOINT_API_KEY")]
  if (env("OPENCODE_COMPAT_ALLOW_SERVER_PASSWORD") === "true") {
    candidates.push(env("OPENCODE_SERVER_PASSWORD"))
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

export async function requireOpenAIBearer(req: Request) {
  const bearerToken = bearer(req.headers.get("authorization") ?? undefined)
  if (bearerToken) {
    if (bearerAuthEnabled()) {
      if (await verifyBearerToken(bearerToken, OPENAI_COMPAT_CONTEXT)) {
        emitAuthDecision({
          source: "compat",
          surface: "openai",
          route: "openai.compat",
          policyMode: "strategies",
          outcome: "allow",
          strategy: "jwt",
          reason: "none",
        })
        return bearerToken
      }
      emitAuthDecision({
        source: "compat",
        surface: "openai",
        route: "openai.compat",
        policyMode: "strategies",
        outcome: "deny",
        strategy: "none",
        reason: "invalid_token",
      })
      return openAIError("unauthorized", "Unauthorized")
    }
    if (authorized(bearerToken)) {
      emitAuthDecision({
        source: "compat",
        surface: "openai",
        route: "openai.compat",
        policyMode: "strategies",
        outcome: "allow",
        strategy: "none",
        reason: "none",
      })
      return bearerToken
    }
    emitAuthDecision({
      source: "compat",
      surface: "openai",
      route: "openai.compat",
      policyMode: "strategies",
      outcome: "deny",
      strategy: "none",
      reason: "invalid_token",
    })
    return openAIError("unauthorized", "Unauthorized")
  }

  emitAuthDecision({
    source: "compat",
    surface: "openai",
    route: "openai.compat",
    policyMode: "strategies",
    outcome: "deny",
    strategy: "none",
    reason: "missing_token",
  })

  return openAIError("unauthorized", "Unauthorized")
}

export function requireAnthropicHeaders(req: Request) {
  const token = req.headers.get("x-api-key")?.trim()
  if (!token || !authorized(token)) return anthropicError("unauthorized", "Unauthorized")

  return token
}
