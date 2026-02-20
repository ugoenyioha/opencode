import { anthropicError, openAIError } from "./error"
import { Env } from "@/env"
import { timingSafeEqual } from "crypto"
import { createHash } from "crypto"
import { createHmac } from "crypto"
import { createPublicKey } from "crypto"
import { createVerify } from "crypto"

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
  exp?: number
  nbf?: number
  iss?: string
  aud?: string | string[]
}

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

function claimChecks(payload: JWTPayload) {
  const now = Math.floor(Date.now() / 1000)
  const skew = Number(Env.get("OPENCODE_COMPAT_JWT_CLOCK_SKEW_SECONDS")) || JWT_CLOCK_SKEW_SECONDS
  const exp = payload.exp
  if (typeof exp === "number" && now >= exp + skew) return false
  const nbf = payload.nbf
  if (typeof nbf === "number" && now < nbf - skew) return false

  const issuer = Env.get("OPENCODE_COMPAT_JWT_ISSUER")
  if (issuer && payload.iss !== issuer) return false

  const audience = Env.get("OPENCODE_COMPAT_JWT_AUDIENCE")
  if (audience) {
    const aud = payload.aud
    if (typeof aud === "string") {
      if (aud !== audience) return false
    } else if (Array.isArray(aud)) {
      if (!aud.includes(audience)) return false
    } else {
      return false
    }
  }

  return true
}

function verifyHS256JWT(parsed: ParsedJWT, secret: string) {
  if (parsed.header.alg !== "HS256") return false
  const expected = createHmac("sha256", secret).update(parsed.signingInput, "utf8").digest()
  if (expected.length !== parsed.signature.length || !timingSafeEqual(parsed.signature, expected)) return false
  return claimChecks(parsed.payload)
}

type JWKSet = {
  keys?: Array<Record<string, unknown>>
}

const jwksCache = new Map<string, { expiresAt: number; keys: Array<Record<string, unknown>> }>()
const JWKS_TTL_MS = 60_000
const JWKS_ERROR_TTL_MS = 10_000
const JWKS_FETCH_TIMEOUT_MS = 5_000
const JWT_CLOCK_SKEW_SECONDS = 30

async function loadJWKS(url: string) {
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
    jwksCache.set(url, { expiresAt: now + JWKS_ERROR_TTL_MS, keys: [] })
    return []
  }
}

async function verifyRS256JWT(parsed: ParsedJWT, jwksURL: string) {
  if (parsed.header.alg !== "RS256") return false
  if (!parsed.header.kid) return false

  const keys = await loadJWKS(jwksURL)
  const jwk = keys.find((key) => key.kid === parsed.header.kid && key.kty === "RSA")
  if (!jwk) return false

  try {
    const publicKey = createPublicKey({ key: jwk, format: "jwk" })
    const verifier = createVerify("RSA-SHA256")
    verifier.update(parsed.signingInput)
    verifier.end()
    if (!verifier.verify(publicKey, parsed.signature)) return false
    return claimChecks(parsed.payload)
  } catch {
    return false
  }
}

async function verifyJWT(token: string) {
  const parsed = parseJWT(token)
  if (!parsed) return false
  if (parsed.header.alg === "none") return false

  const hs256Secret = Env.get("OPENCODE_COMPAT_JWT_HS256_SECRET")
  const jwksURL = Env.get("OPENCODE_COMPAT_JWT_JWKS_URL")

  if (parsed.header.alg === "HS256") {
    if (!hs256Secret) return false
    return verifyHS256JWT(parsed, hs256Secret)
  }
  if (parsed.header.alg === "RS256") {
    if (!jwksURL) return false
    return verifyRS256JWT(parsed, jwksURL)
  }
  return false
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

export async function requireOpenAIBearer(req: Request) {
  const bearerToken = bearer(req.headers.get("authorization") ?? undefined)
  if (bearerToken) {
    const jwtEnabled = !!Env.get("OPENCODE_COMPAT_JWT_JWKS_URL") || !!Env.get("OPENCODE_COMPAT_JWT_HS256_SECRET")
    if (jwtEnabled) {
      if (await verifyJWT(bearerToken)) return bearerToken
      return openAIError("unauthorized", "Unauthorized")
    }
    if (authorized(bearerToken)) return bearerToken
    return openAIError("unauthorized", "Unauthorized")
  }

  const apiKeyToken = apiKey(req.headers.get("x-api-key") ?? undefined)
  if (apiKeyToken && authorized(apiKeyToken)) return apiKeyToken

  return openAIError("unauthorized", "Unauthorized")
}

export function requireAnthropicHeaders(req: Request) {
  const token = req.headers.get("x-api-key")?.trim()
  if (!token || !authorized(token)) return anthropicError("unauthorized", "Unauthorized")

  return token
}
