/// <reference path="./spiffe.d.ts" />
import { createClient as createSPIFFEClient } from "spiffe"
import { Log } from "@/util/log"
import { minimatch } from "minimatch"

const log = Log.create({ service: "spiffe" })

type SPIFFEVerificationResult = {
  ok: boolean
  spiffeId?: string
  claims?: Record<string, unknown>
}

let clientInstance: ReturnType<typeof createSPIFFEClient> | null = null
let lastError: Error | null = null
let lastReconnectAttempt = 0
const RECONNECT_COOLDOWN_MS = 5000
const SAFE_MATCH_OPTIONS = {
  nonegate: true,
  noext: true,
  nobrace: true,
  nocomment: true,
} as const

/**
 * Get or create the SPIFFE Workload API client.
 * Uses SPIFFE_ENDPOINT_SOCKET env var (standard SPIFFE env var).
 * Reconnects on failure with 5s cooldown.
 */
function getClient() {
  const now = Date.now()
  
  // If we have a working client, return it
  if (clientInstance && !lastError) {
    return clientInstance
  }

  // Rate-limit reconnection attempts
  if (lastError && now - lastReconnectAttempt < RECONNECT_COOLDOWN_MS) {
    throw lastError
  }

  try {
    const endpoint = process.env["SPIFFE_ENDPOINT_SOCKET"]
    if (!endpoint) {
      throw new Error("SPIFFE_ENDPOINT_SOCKET environment variable not set")
    }

    lastReconnectAttempt = now
    clientInstance = createSPIFFEClient(endpoint)
    lastError = null
    log.info("SPIFFE Workload API client connected", { endpoint: sanitizeEndpoint(endpoint) })
    return clientInstance
  } catch (error) {
    lastError = error instanceof Error ? error : new Error(String(error))
    log.error("Failed to create SPIFFE client", { error: lastError.message })
    throw lastError
  }
}

/**
 * Sanitize endpoint for logging (remove socket path details for security).
 */
function sanitizeEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    return `${url.protocol}//${url.hostname || "socket"}`
  } catch {
    return endpoint.startsWith("unix://") ? "unix://[redacted]" : "unknown"
  }
}

function sanitizeSpiffeId(spiffeId: string): string {
  if (!spiffeId.startsWith("spiffe://")) return "spiffe://[invalid]"
  try {
    const parsed = new URL(spiffeId)
    return `spiffe://${parsed.host}/...`
  } catch {
    return "spiffe://[redacted]"
  }
}

function isSafeAllowedPattern(pattern: string): boolean {
  const normalized = pattern.trim()
  if (!normalized.startsWith("spiffe://")) return false
  if (normalized.includes("!")) return false
  if (normalized.includes("(") || normalized.includes(")")) return false
  if (normalized.includes("{") || normalized.includes("}")) return false
  return true
}

/**
 * Check if a SPIFFE ID matches any of the allowed patterns (glob).
 */
function isAllowedSpiffeId(spiffeId: string, allowedIds?: string[]): boolean {
  if (!allowedIds || allowedIds.length === 0) return true
  
  return allowedIds.some((pattern, index) => {
    const normalized = pattern.trim()
    if (!isSafeAllowedPattern(normalized)) {
      log.warn("Ignoring unsafe SPIFFE allowlist pattern", { patternIndex: index })
      return false
    }

    try {
      return minimatch(spiffeId, normalized, SAFE_MATCH_OPTIONS)
    } catch {
      log.warn("Invalid SPIFFE ID allowlist pattern", { patternIndex: index })
      return false
    }
  })
}

/**
 * Verify a SPIFFE JWT-SVID token via delegated validation.
 * Calls the SPIRE Agent's Workload API to validate the token.
 * 
 * @param token - JWT-SVID Bearer token
 * @param audience - Required audience claim
 * @param allowedIds - Optional list of allowed SPIFFE ID glob patterns
 * @returns Verification result with spiffeId and claims if successful
 */
export async function verifySPIFFE(
  token: string,
  audience: string,
  allowedIds?: string[],
): Promise<boolean> {
  try {
    const client = getClient()
    
    // Call SPIRE Agent with 5s timeout
    const timeoutMs = 5000
    const validationPromise = client.validateJWTSVID({
      audience,
      svid: token,
    })

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("SPIFFE validation timeout")), timeoutMs)
    })

    const result = await Promise.race([validationPromise, timeoutPromise])

    if (!result?.spiffeId) {
      log.warn("SPIFFE validation failed: no spiffeId in response")
      return false
    }

    // Check SPIFFE ID allowlist
    if (!isAllowedSpiffeId(result.spiffeId, allowedIds)) {
      log.warn("SPIFFE ID not in allowlist", {
        spiffeId: sanitizeSpiffeId(result.spiffeId),
        allowedPatternCount: allowedIds?.length ?? 0,
      })
      return false
    }

    log.debug("SPIFFE JWT-SVID validated", {
      spiffeId: sanitizeSpiffeId(result.spiffeId),
      audience,
    })

    return true
  } catch (error) {
    // Fail-closed: any error (network, timeout, validation failure) → deny
    const message = error instanceof Error ? error.message : String(error)
    log.warn("SPIFFE verification failed", { error: message, audience })
    
    // If this was a connection error, mark client as failed for reconnection
    if (error instanceof Error && error.message.includes("SPIFFE_ENDPOINT_SOCKET")) {
      lastError = error
      clientInstance = null
    }
    
    return false
  }
}
