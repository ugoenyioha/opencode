/// <reference path="./spiffe.d.ts" />
/**
 * SPIFFE JWT-SVID verification via the SPIRE Workload API.
 *
 * NOTE ON THE `spiffe` npm PACKAGE (v0.5.0):
 *
 * The `spiffe` package's `createClient()` returns a client whose async
 * methods (e.g. `validateJWTSVID()`) resolve to a `UnaryCall` envelope
 * from `@protobuf-ts/runtime-rpc`, NOT the raw response message. The
 * actual response lives at `result.response`, so accessing
 * `result.spiffeId` returns `undefined`. Additionally, the `UnaryCall`
 * envelope contains circular references through its protobuf type
 * metadata — any attempt to `JSON.stringify` it (e.g. for logging)
 * throws "Converting circular structure to JSON".
 *
 * Rather than depend on the `@protobuf-ts/runtime-rpc` `UnaryCall`
 * wrapper semantics (which are easy to misuse), this module calls
 * `@grpc/grpc-js` `makeUnaryRequest` directly and uses the spiffe
 * package's protobuf types (`toBinary` / `fromBinary`) for wire
 * serialization. This gives us a plain response object with no wrapper,
 * no circular references, and no ambiguity about where `spiffeId` lives.
 */
import { Log } from "@/util/log"
import { minimatch } from "minimatch"

const log = Log.create({ service: "spiffe" })

// ---------------------------------------------------------------------------
// Lazy-loaded gRPC + protobuf deps (avoids import errors when not in SPIFFE env)
// ---------------------------------------------------------------------------

let _grpc: typeof import("@grpc/grpc-js") | null = null
let _protoTypes: {
  ValidateJWTSVIDRequest: any
  ValidateJWTSVIDResponse: any
  Struct: any
} | null = null

async function loadGrpc() {
  if (!_grpc) {
    _grpc = await import("@grpc/grpc-js")
  }
  return _grpc
}

function loadProtoTypes() {
  if (!_protoTypes) {
    // Use require() to load the CJS bundle — the ESM entry point is broken
    // (the package declares dist/index.js but only ships .mjs/.cjs; a
    //  postinstall symlink patches this for ESM imports, but require() with
    //  the .cjs path is more reliable for this usage).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const spiffe = require("spiffe")
    _protoTypes = {
      ValidateJWTSVIDRequest: spiffe.ValidateJWTSVIDRequest,
      ValidateJWTSVIDResponse: spiffe.ValidateJWTSVIDResponse,
      Struct: spiffe.Struct,
    }
  }
  return _protoTypes
}

// ---------------------------------------------------------------------------
// gRPC client management
// ---------------------------------------------------------------------------

type GrpcClient = InstanceType<typeof import("@grpc/grpc-js").Client>

let clientInstance: GrpcClient | null = null
let clientEndpoint: string | null = null
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
 * Get or create a raw @grpc/grpc-js Client connected to the SPIRE agent socket.
 * Reconnects on failure with a 5 s cooldown.
 */
async function getClient(): Promise<GrpcClient> {
  const now = Date.now()

  if (clientInstance && !lastError) {
    return clientInstance
  }

  if (lastError && now - lastReconnectAttempt < RECONNECT_COOLDOWN_MS) {
    throw lastError
  }

  try {
    const endpoint = process.env["SPIFFE_ENDPOINT_SOCKET"]
    if (!endpoint) {
      throw new Error("SPIFFE_ENDPOINT_SOCKET environment variable not set")
    }

    const grpc = await loadGrpc()
    lastReconnectAttempt = now

    // Close stale client if any
    if (clientInstance) {
      try {
        clientInstance.close()
      } catch {
        /* ignore */
      }
    }

    clientInstance = new grpc.Client(endpoint, grpc.credentials.createInsecure())
    clientEndpoint = endpoint
    lastError = null
    log.info("SPIFFE gRPC client connected", { endpoint: sanitizeEndpoint(endpoint) })
    return clientInstance
  } catch (error) {
    lastError = error instanceof Error ? error : new Error(String(error))
    log.error("Failed to create SPIFFE gRPC client", { error: lastError.message })
    throw lastError
  }
}

// ---------------------------------------------------------------------------
// Raw gRPC call: ValidateJWTSVID
// ---------------------------------------------------------------------------

/**
 * Call SPIRE Agent's ValidateJWTSVID via raw gRPC, bypassing the buggy
 * `spiffe` package `stackIntercept` wrapper.
 */
async function callValidateJWTSVID(
  audience: string,
  svid: string,
): Promise<{ spiffeId: string; claims: Record<string, unknown> }> {
  const client = await getClient()
  const grpc = await loadGrpc()
  const proto = loadProtoTypes()

  const metadata = new grpc.Metadata()
  metadata.set("workload.spiffe.io", "true")

  return new Promise((resolve, reject) => {
    client.makeUnaryRequest<{ audience: string; svid: string }, any>(
      "/SpiffeWorkloadAPI/ValidateJWTSVID",
      // Serializer: protobuf binary via @protobuf-ts/runtime (no JSON involved)
      (req) => {
        const msg = proto.ValidateJWTSVIDRequest.create(req)
        return Buffer.from(proto.ValidateJWTSVIDRequest.toBinary(msg))
      },
      // Deserializer: protobuf binary → JS object
      (data) => {
        return proto.ValidateJWTSVIDResponse.fromBinary(new Uint8Array(data))
      },
      { audience, svid },
      metadata,
      { deadline: Date.now() + 5000 },
      (err, response) => {
        if (err) return reject(err)
        if (!response) return reject(new Error("Empty response from SPIRE agent"))

        // Convert google.protobuf.Struct → plain object safely
        let claims: Record<string, unknown> = {}
        try {
          if (response.claims) {
            claims = proto.Struct.toJson(response.claims) as Record<string, unknown>
          }
        } catch {
          // If Struct conversion fails, log but don't fail the whole validation
          log.warn("Failed to convert SPIFFE claims Struct to JSON")
        }

        resolve({
          spiffeId: response.spiffeId ?? "",
          claims,
        })
      },
    )
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Verify a SPIFFE JWT-SVID token via delegated validation.
 * Calls the SPIRE Agent's Workload API to validate the token.
 *
 * @param token     JWT-SVID Bearer token
 * @param audience  Required audience claim
 * @param allowedIds  Optional list of allowed SPIFFE ID glob patterns
 * @returns The authenticated SPIFFE ID string on success, or `false` on failure.
 *          Returning the SPIFFE ID (rather than boolean) allows the auth pipeline
 *          to thread the caller's identity into ext_authz and observability.
 */
export async function verifySPIFFE(
  token: string,
  audience: string,
  allowedIds?: string[],
): Promise<string | false> {
  try {
    const result = await callValidateJWTSVID(audience, token)

    if (!result.spiffeId) {
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

    return result.spiffeId
  } catch (error) {
    // Fail-closed: any error (network, timeout, validation failure) → deny
    const message = error instanceof Error ? error.message : String(error)
    log.warn("SPIFFE verification failed", { error: message, audience })

    // If this was a connection error, mark client as failed for reconnection
    if (
      error instanceof Error &&
      (error.message.includes("SPIFFE_ENDPOINT_SOCKET") ||
        error.message.includes("UNAVAILABLE") ||
        error.message.includes("ECONNREFUSED"))
    ) {
      lastError = error
      clientInstance = null
    }

    return false
  }
}

let cachedWorkloadPrincipal: string | null = null
let lastPrincipalFetchAttempt = 0
const PRINCIPAL_CACHE_TTL_MS = 60_000

/**
 * Resolve the local workload principal (SPIFFE ID) via Workload API FetchX509SVID.
 * Returns null on failure and never throws (fail-closed friendly for authz callers).
 */
export async function fetchLocalWorkloadIdentity(): Promise<string | null> {
  const now = Date.now()
  if (cachedWorkloadPrincipal && now - lastPrincipalFetchAttempt < PRINCIPAL_CACHE_TTL_MS) {
    return cachedWorkloadPrincipal
  }

  if (lastError && now - lastReconnectAttempt < RECONNECT_COOLDOWN_MS) {
    return null
  }

  try {
    const client = await getClient()
    const grpc = await loadGrpc()
    const proto = loadProtoTypes()
    const metadata = new grpc.Metadata()

    return await new Promise((resolve) => {
      const call = client.makeServerStreamRequest<any, any>(
        "/SpiffeWorkloadAPI/FetchX509SVID",
        (req) => {
          const msg = proto.X509SVIDRequest.create(req)
          return Buffer.from(proto.X509SVIDRequest.toBinary(msg))
        },
        (data) => proto.X509SVIDResponse.fromBinary(new Uint8Array(data)),
        {},
        metadata,
        { deadline: Date.now() + 5_000 },
      )

      call.on("data", (response) => {
        const spiffeId = response?.svids?.[0]?.spiffeId
        if (!spiffeId) return
        cachedWorkloadPrincipal = spiffeId
        lastPrincipalFetchAttempt = Date.now()
        resolve(spiffeId)
        call.cancel()
      })

      call.on("error", () => resolve(null))
      call.on("end", () => resolve(cachedWorkloadPrincipal))
    })
  } catch (error) {
    log.warn("Failed to fetch local workload identity from SPIFFE", {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}
