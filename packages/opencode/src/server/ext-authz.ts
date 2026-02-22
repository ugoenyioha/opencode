/**
 * Envoy ext_authz v3 gRPC client for OpenCode.
 *
 * Implements the client side of the `envoy.service.auth.v3.Authorization/Check`
 * gRPC protocol. Compatible with any ext_authz server (OPA, SpiceDB adapters,
 * Cedar adapters, custom servers).
 *
 * Design decisions:
 *   - Uses static protobuf codecs (no runtime proto-loader/protobuf file I/O).
 *   - Lazy-loads gRPC deps to avoid import errors when ext_authz
 *     is not configured.
 *   - Client lifecycle: create-on-first-use, reconnect on failure with cooldown.
 *   - Fail-closed by default (configurable via `failOpen`).
 *   - Timeout is enforced via gRPC deadline.
 *
 * Wire format: the self-contained proto uses the canonical
 * `envoy.service.auth.v3` package name and field numbers, so the serialized
 * messages are byte-identical to what a real Envoy proxy would send.
 */

import { Log } from "@/util/log"
import protobuf from "protobufjs"
import type { AuthnResult } from "./auth-policy"

const log = Log.create({ service: "ext-authz" })

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

export type ExtAuthzConfig = {
  /** gRPC endpoint, e.g. "grpc://opa:9191" or "dns:///opa.svc.cluster.local:9191" */
  endpoint: string
  /** Timeout in milliseconds (default: 500). */
  timeout?: number
  /** If true, allow requests when the ext_authz server is unreachable (default: false). */
  failOpen?: boolean
  /** Optional request body forwarding config. */
  withRequestBody?: {
    maxBytes?: number
    allowPartial?: boolean
  }
  /** Static key-value pairs added to CheckRequest.attributes.context_extensions. */
  contextExtensions?: Record<string, string>
  /**
   * Optional endpoint for opencode.authz.v1.BatchAuthorizationService.
   * When set, discovery uses a single BatchCheck RPC instead of N individual
   * ext_authz Check calls. Falls back to parallel individual checks on error.
   * If unset, defaults to the same endpoint as `endpoint` (the adapter serves
   * both services on the same port).
   */
  batchEndpoint?: string
}

export type ExtAuthzDecision = {
  allowed: boolean
  /** HTTP status code from the authz server (0 = OK, anything else = deny). */
  statusCode: number
  /** Human-readable reason for the decision. */
  reason: string
  /** Headers the authz server wants added/set on the request (from OkHttpResponse). */
  responseHeaders?: Record<string, string>
  /** Headers the authz server wants removed. */
  headersToRemove?: string[]
  /** Dynamic metadata from the authz server. */
  dynamicMetadata?: Record<string, unknown>
  /** Time taken for the ext_authz call in milliseconds. */
  latencyMs: number
}

export type BatchCheckItem = {
  /** The agent ID to check. */
  agentId: string
  /** The permission to check (e.g. "view", "invoke"). */
  permission: string
}

export type BatchCheckResult = {
  agentId: string
  allowed: boolean
  error?: string
}

export type ExtAuthzRequestContext = {
  /** HTTP method (GET, POST, etc.) */
  method: string
  /** URL path including query string. */
  path: string
  /** Request headers. */
  headers: Record<string, string>
  /** Host / :authority header. */
  host: string
  /** URL scheme (http / https). */
  scheme?: string
  /** Request body (if withRequestBody is configured). */
  body?: string
  /** Source principal (from authn step). */
  sourcePrincipal?: string
  /** Source service name. */
  sourceService?: string
  /** Destination service name (this agent). */
  destinationService?: string
  /** Agent ID being accessed. */
  agentId?: string
  /** Skill being invoked (if applicable). */
  skill?: string
  /** Session ID (if applicable). */
  sessionId?: string
  /** Auth strategy that was used for authn. */
  authStrategy?: string
}

// ---------------------------------------------------------------------------
// Lazy-loaded gRPC deps + static protobuf codec (no runtime proto-loader)
// ---------------------------------------------------------------------------

let _grpc: typeof import("@grpc/grpc-js") | null = null
let _authzServiceDef: any = null

async function loadGrpc() {
  if (!_grpc) _grpc = await import("@grpc/grpc-js")
  return _grpc
}

const encodeMap = (w: protobuf.Writer, field: number, map: Record<string, string>) => {
  for (const [k, v] of Object.entries(map)) {
    w.uint32((field << 3) | 2).fork().uint32(10).string(k).uint32(18).string(v).ldelim()
  }
}

const encodeCheckRequest = (input: any) => {
  const w = protobuf.Writer.create()
  const a = input?.attributes
  if (!a) return w.finish()
  w.uint32(10).fork()
  const source = a.source
  if (source) {
    w.uint32(10).fork()
    if (source.service) w.uint32(18).string(source.service)
    if (source.principal) w.uint32(34).string(source.principal)
    w.ldelim()
  }
  const destination = a.destination
  if (destination) {
    w.uint32(18).fork()
    if (destination.service) w.uint32(18).string(destination.service)
    w.ldelim()
  }
  const req = a.request?.http
  if (req) {
    w.uint32(34).fork().uint32(18).fork()
    if (req.id) w.uint32(10).string(req.id)
    if (req.method) w.uint32(18).string(req.method)
    if (req.headers) encodeMap(w, 3, req.headers)
    if (req.path) w.uint32(34).string(req.path)
    if (req.host) w.uint32(42).string(req.host)
    if (req.scheme) w.uint32(50).string(req.scheme)
    if (req.protocol) w.uint32(82).string(req.protocol)
    if (typeof req.size === "number") w.uint32(72).int64(req.size)
    if (req.body) w.uint32(90).string(req.body)
    w.ldelim().ldelim()
  }
  if (a.contextExtensions) encodeMap(w, 10, a.contextExtensions)
  w.ldelim()
  return w.finish()
}

const decodeStatus = (r: protobuf.Reader) => {
  const end = r.uint32() + r.pos
  const out: any = { code: 0, message: "" }
  while (r.pos < end) {
    const tag = r.uint32()
    if ((tag >>> 3) === 1) {
      out.code = r.int32()
      continue
    }
    if ((tag >>> 3) === 2) {
      out.message = r.string()
      continue
    }
    r.skipType(tag & 7)
  }
  return out
}

const decodeHeaderValue = (r: protobuf.Reader) => {
  const end = r.uint32() + r.pos
  const out: any = { key: "", value: "" }
  while (r.pos < end) {
    const tag = r.uint32()
    if ((tag >>> 3) === 1) {
      out.key = r.string()
      continue
    }
    if ((tag >>> 3) === 2) {
      out.value = r.string()
      continue
    }
    r.skipType(tag & 7)
  }
  return out
}

const decodeHeaderValueOption = (r: protobuf.Reader) => {
  const end = r.uint32() + r.pos
  const out: any = {}
  while (r.pos < end) {
    const tag = r.uint32()
    if ((tag >>> 3) === 1) {
      out.header = decodeHeaderValue(r)
      continue
    }
    r.skipType(tag & 7)
  }
  return out
}

const decodeOkResponse = (r: protobuf.Reader) => {
  const end = r.uint32() + r.pos
  const out: any = { headers: [], headersToRemove: [] }
  while (r.pos < end) {
    const tag = r.uint32()
    if ((tag >>> 3) === 2) {
      out.headers.push(decodeHeaderValueOption(r))
      continue
    }
    if ((tag >>> 3) === 5) {
      out.headersToRemove.push(r.string())
      continue
    }
    r.skipType(tag & 7)
  }
  return out
}

const decodeDeniedResponse = (r: protobuf.Reader) => {
  const end = r.uint32() + r.pos
  const out: any = {}
  while (r.pos < end) {
    const tag = r.uint32()
    if ((tag >>> 3) === 1) {
      const statusEnd = r.uint32() + r.pos
      const status: any = { code: 0 }
      while (r.pos < statusEnd) {
        const statusTag = r.uint32()
        if ((statusTag >>> 3) === 1) {
          status.code = r.int32()
          continue
        }
        r.skipType(statusTag & 7)
      }
      out.status = status
      continue
    }
    if ((tag >>> 3) === 3) {
      out.body = r.string()
      continue
    }
    r.skipType(tag & 7)
  }
  return out
}

const decodeCheckResponse = (bytes: Uint8Array) => {
  const r = protobuf.Reader.create(bytes)
  const out: any = {}
  while (r.pos < r.len) {
    const tag = r.uint32()
    if ((tag >>> 3) === 1) {
      out.status = decodeStatus(r)
      continue
    }
    if ((tag >>> 3) === 2) {
      out.deniedResponse = decodeDeniedResponse(r)
      continue
    }
    if ((tag >>> 3) === 3) {
      out.okResponse = decodeOkResponse(r)
      continue
    }
    if ((tag >>> 3) === 4) {
      // dynamic_metadata (google.protobuf.Struct). We do not need full Struct
      // decoding for policy decisions; preserve a truthy placeholder so callers
      // can observe metadata presence.
      r.skipType(2)
      out.dynamicMetadata = {}
      continue
    }
    if ((tag >>> 3) === 5) {
      out.deniedResponse = decodeDeniedResponse(r)
      continue
    }
    r.skipType(tag & 7)
  }
  return out
}

const encodeBatchCheckRequest = (input: any) => {
  const w = protobuf.Writer.create()
  if (input?.principal) w.uint32(10).string(input.principal)
  for (const item of input?.items ?? []) {
    w.uint32(18).fork()
    if (item.agentId) w.uint32(10).string(item.agentId)
    if (item.permission) w.uint32(18).string(item.permission)
    w.ldelim()
  }
  return w.finish()
}

const decodeBatchCheckResponse = (bytes: Uint8Array) => {
  const r = protobuf.Reader.create(bytes)
  const out: any = { results: [] }
  while (r.pos < r.len) {
    const tag = r.uint32()
    if ((tag >>> 3) !== 1) {
      r.skipType(tag & 7)
      continue
    }
    const end = r.uint32() + r.pos
    const result: any = { agentId: "", allowed: false, error: "" }
    while (r.pos < end) {
      const inner = r.uint32()
      if ((inner >>> 3) === 1) {
        result.agentId = r.string()
        continue
      }
      if ((inner >>> 3) === 2) {
        result.allowed = r.bool()
        continue
      }
      if ((inner >>> 3) === 3) {
        result.error = r.string()
        continue
      }
      r.skipType(inner & 7)
    }
    out.results.push(result)
  }
  return out
}

const encodeEmpty = () => Buffer.alloc(0)
const decodeEmpty = () => ({})

async function loadProto() {
  if (_authzServiceDef) return _authzServiceDef
  const grpc = await loadGrpc()
  _authzServiceDef = grpc.makeGenericClientConstructor(
    {
      check: {
        path: "/envoy.service.auth.v3.Authorization/Check",
        requestStream: false,
        responseStream: false,
        requestSerialize: (v: any) => Buffer.from(encodeCheckRequest(v)),
        requestDeserialize: decodeEmpty,
        responseSerialize: encodeEmpty,
        responseDeserialize: (b: Buffer) => decodeCheckResponse(new Uint8Array(b)),
      },
    },
    "Authorization",
  )
  return _authzServiceDef
}

// ---------------------------------------------------------------------------
// Client management
// ---------------------------------------------------------------------------

// Dynamic gRPC client constructor — use `any` because method signatures
// are attached by makeGenericClientConstructor at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AuthzClient = any

const clients = new Map<string, {
  client: AuthzClient
  lastError: Error | null
  lastReconnectAttempt: number
}>()

const RECONNECT_COOLDOWN_MS = 5000

async function getClient(config: ExtAuthzConfig): Promise<AuthzClient> {
  const endpoint = config.endpoint
  const entry = clients.get(endpoint)
  const now = Date.now()

  if (entry?.client && !entry.lastError) {
    return entry.client
  }

  if (entry?.lastError && now - entry.lastReconnectAttempt < RECONNECT_COOLDOWN_MS) {
    throw entry.lastError
  }

  const grpc = await loadGrpc()
  const ServiceConstructor = await loadProto()

  const parsed = parseGrpcEndpoint(endpoint)
  const target = parsed.target

  // Close stale client if any
  if (entry?.client) {
    try {
      entry.client.close()
    } catch {
      /* ignore */
    }
  }

  try {
    // Prefer explicit transport by endpoint scheme to avoid brittle assumptions.
    // - grpc://host:port  -> insecure
    // - grpcs://host:port -> TLS
    // - dns:///...        -> insecure (in-cluster resolver target)
    // - localhost/loopback/unix -> insecure
    const creds = parsed.insecure
      ? grpc.credentials.createInsecure()
      : grpc.credentials.createSsl()

    const client = new ServiceConstructor(target, creds)

    clients.set(endpoint, {
      client,
      lastError: null,
      lastReconnectAttempt: now,
    })

    log.info("ext_authz gRPC client connected", { endpoint: sanitizeEndpoint(endpoint) })
    return client
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    clients.set(endpoint, {
      client: null as any,
      lastError: err,
      lastReconnectAttempt: now,
    })
    log.error("Failed to create ext_authz gRPC client", {
      error: err.message,
      stack: err.stack,
    })
    throw err
  }
}

// ---------------------------------------------------------------------------
// Core: checkAuthorization
// ---------------------------------------------------------------------------

/**
 * Call the ext_authz server to check whether a request is authorized.
 *
 * @param config   ext_authz configuration (endpoint, timeout, failOpen, etc.)
 * @param context  Request context to build the CheckRequest from.
 * @param authn    Authentication result (from the authn step).
 * @returns ExtAuthzDecision — whether the request is allowed/denied.
 */
export async function checkAuthorization(
  config: ExtAuthzConfig,
  context: ExtAuthzRequestContext,
  authn?: AuthnResult,
): Promise<ExtAuthzDecision> {
  const startTime = Date.now()
  const timeout = parseTimeoutMs(config.timeout)

  try {
    const client = await getClient(config)

    // Build CheckRequest
    const checkRequest = buildCheckRequest(config, context, authn)

    // Make the gRPC call
    const response = await new Promise<any>((resolve, reject) => {
      client.check(
        checkRequest,
        { deadline: Date.now() + timeout },
        (err: Error | null, response: any) => {
          if (err) return reject(err)
          resolve(response)
        },
      )
    })

    return parseCheckResponse(response, Date.now() - startTime)
  } catch (error) {
    const latencyMs = Date.now() - startTime
    const message = error instanceof Error ? error.message : String(error)
    const stack = error instanceof Error ? error.stack : undefined

    // Mark client as failed for reconnection on connection errors
    if (
      error instanceof Error &&
      (message.includes("UNAVAILABLE") ||
        message.includes("ECONNREFUSED") ||
        message.includes("DEADLINE_EXCEEDED"))
    ) {
      const entry = clients.get(config.endpoint)
      if (entry) {
        entry.lastError = error
      }
    }

    log.warn("ext_authz call failed", {
      error: message,
      stack,
      endpoint: sanitizeEndpoint(config.endpoint),
      latencyMs,
      failOpen: config.failOpen ?? false,
    })

    // Fail-open or fail-closed
    if (config.failOpen) {
      return {
        allowed: true,
        statusCode: 0,
        reason: `ext_authz_error_failopen: ${message}`,
        latencyMs,
      }
    }

    return {
      allowed: false,
      statusCode: 503,
      reason: `ext_authz_error: ${message}`,
      latencyMs,
    }
  }
}

// ---------------------------------------------------------------------------
// Build CheckRequest
// ---------------------------------------------------------------------------

function buildCheckRequest(
  config: ExtAuthzConfig,
  context: ExtAuthzRequestContext,
  authn?: AuthnResult,
): any {
  // Build headers map (all lowercase keys per Envoy spec)
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(context.headers)) {
    headers[key.toLowerCase()] = value
  }

  // Build context_extensions: static config + dynamic request context
  const contextExtensions: Record<string, string> = {
    ...(config.contextExtensions ?? {}),
  }
  if (context.agentId) contextExtensions["opencode.agent"] = context.agentId
  if (context.skill) contextExtensions["opencode.skill"] = context.skill
  if (context.sessionId) contextExtensions["opencode.session"] = context.sessionId
  if (context.authStrategy) contextExtensions["opencode.auth_strategy"] = context.authStrategy
  if (authn?.strategy && authn.strategy !== "none") {
    contextExtensions["opencode.authn_strategy"] = authn.strategy
  }
  if (authn?.principal) {
    contextExtensions["opencode.principal"] = authn.principal
  }

  // Build HTTP request
  const httpRequest: any = {
    id: headers["x-request-id"] ?? "",
    method: context.method,
    headers,
    path: context.path,
    host: context.host,
    scheme: context.scheme ?? "https",
    protocol: "HTTP/1.1",
    size: context.body ? Buffer.byteLength(context.body, "utf8") : -1,
  }

  // Optionally include request body
  if (context.body && config.withRequestBody) {
    const maxBytes = config.withRequestBody.maxBytes ?? 0
    if (maxBytes > 0) {
      const bodyBytes = Buffer.byteLength(context.body, "utf8")
      if (bodyBytes <= maxBytes || config.withRequestBody.allowPartial) {
        httpRequest.body = context.body.slice(0, maxBytes)
      }
    }
  }

  return {
    attributes: {
      source: {
        principal: authn?.principal ?? context.sourcePrincipal ?? "",
        service: context.sourceService ?? "",
      },
      destination: {
        service: context.destinationService ?? "",
      },
      request: {
        http: httpRequest,
      },
      contextExtensions,
    },
  }
}

// ---------------------------------------------------------------------------
// Parse CheckResponse
// ---------------------------------------------------------------------------

function parseCheckResponse(response: any, latencyMs: number): ExtAuthzDecision {
  if (!response) {
    return {
      allowed: false,
      statusCode: 500,
      reason: "ext_authz: empty response",
      latencyMs,
    }
  }

  // status.code == 0 means OK (google.rpc.Code.OK)
  const statusCode = response.status?.code ?? 0
  const allowed = statusCode === 0

  const decision: ExtAuthzDecision = {
    allowed,
    statusCode,
    reason: allowed ? "ext_authz_ok" : (response.status?.message || "ext_authz_denied"),
    latencyMs,
  }

  // Extract headers from ok_response
  if (allowed && response.okResponse) {
    const respHeaders: Record<string, string> = {}
    for (const hvo of response.okResponse.headers ?? []) {
      if (hvo.header?.key) {
        respHeaders[hvo.header.key] = hvo.header.value ?? ""
      }
    }
    if (Object.keys(respHeaders).length > 0) {
      decision.responseHeaders = respHeaders
    }
    if (response.okResponse.headersToRemove?.length > 0) {
      decision.headersToRemove = response.okResponse.headersToRemove
    }
  }

  // Extract denied response details
  if (!allowed && response.deniedResponse) {
    const deniedStatus = response.deniedResponse.status?.code
    if (deniedStatus) {
      decision.statusCode = deniedStatus
    }
    if (response.deniedResponse.body) {
      decision.reason = response.deniedResponse.body
    }
  }

  // Extract dynamic metadata
  if (response.dynamicMetadata) {
    try {
      decision.dynamicMetadata = response.dynamicMetadata as Record<string, unknown>
    } catch {
      // If struct conversion fails, skip it
    }
  }

  return decision
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a timeout value that can be a number (ms) or a string ("500ms", "2s").
 * Returns the timeout in milliseconds. Defaults to 500ms if not provided or invalid.
 */
function parseTimeoutMs(timeout: number | string | undefined): number {
  if (timeout === undefined) return 500
  if (typeof timeout === "number") return timeout
  const match = timeout.match(/^(\d+)(ms|s)$/)
  if (!match) {
    log.warn("Invalid ext_authz timeout format, using default 500ms", { timeout })
    return 500
  }
  const value = parseInt(match[1]!, 10)
  return match[2] === "s" ? value * 1000 : value
}

function sanitizeEndpoint(endpoint: string): string {
  try {
    if (endpoint.startsWith("grpc://")) {
      const hostPort = endpoint.slice("grpc://".length)
      const host = hostPort.split(":")[0]
      return `grpc://${host}:***`
    }
    return endpoint.replace(/:\d+$/, ":***")
  } catch {
    return "unknown"
  }
}

function parseGrpcEndpoint(endpoint: string): { target: string, insecure: boolean } {
  if (endpoint.startsWith("grpc://")) {
    return {
      target: endpoint.slice("grpc://".length),
      insecure: true,
    }
  }

  if (endpoint.startsWith("grpcs://")) {
    return {
      target: endpoint.slice("grpcs://".length),
      insecure: false,
    }
  }

  if (endpoint.startsWith("dns:///")) {
    return {
      target: endpoint,
      insecure: true,
    }
  }

  if (endpoint.startsWith("unix://") || endpoint.startsWith("unix:")) {
    return {
      target: endpoint,
      insecure: true,
    }
  }

  return {
    target: endpoint,
    insecure:
      endpoint.startsWith("localhost") ||
      endpoint.startsWith("127.0.0.1") ||
      endpoint.startsWith("[::1]") ||
      endpoint.includes("://localhost"),
  }
}

// ---------------------------------------------------------------------------
// Batch authorization: opencode.authz.v1.BatchAuthorizationService/BatchCheck
// ---------------------------------------------------------------------------

let _batchServiceDef: any = null
const batchClients = new Map<string, {
  client: any
  lastError: Error | null
  lastReconnectAttempt: number
}>()

async function loadBatchProto() {
  if (_batchServiceDef) return _batchServiceDef
  const grpc = await loadGrpc()
  _batchServiceDef = grpc.makeGenericClientConstructor(
    {
      batchCheck: {
        path: "/opencode.authz.v1.BatchAuthorizationService/BatchCheck",
        requestStream: false,
        responseStream: false,
        requestSerialize: (v: any) => Buffer.from(encodeBatchCheckRequest(v)),
        requestDeserialize: decodeEmpty,
        responseSerialize: encodeEmpty,
        responseDeserialize: (b: Buffer) => decodeBatchCheckResponse(new Uint8Array(b)),
      },
    },
    "BatchAuthorizationService",
  )

  return _batchServiceDef
}

async function getBatchClient(config: ExtAuthzConfig): Promise<any> {
  const endpoint = config.batchEndpoint ?? config.endpoint
  const entry = batchClients.get(endpoint)
  const now = Date.now()

  if (entry?.client && !entry.lastError) {
    return entry.client
  }

  if (entry?.lastError && now - entry.lastReconnectAttempt < RECONNECT_COOLDOWN_MS) {
    throw entry.lastError
  }

  const grpc = await loadGrpc()
  const ServiceConstructor = await loadBatchProto()

  const parsed = parseGrpcEndpoint(endpoint)
  const target = parsed.target

  if (entry?.client) {
    try { entry.client.close() } catch { /* ignore */ }
  }

  try {
    const creds = parsed.insecure
      ? grpc.credentials.createInsecure()
      : grpc.credentials.createSsl()

    const client = new ServiceConstructor(target, creds)

    batchClients.set(endpoint, {
      client,
      lastError: null,
      lastReconnectAttempt: now,
    })

    log.info("batch authz gRPC client connected", { endpoint: sanitizeEndpoint(endpoint) })
    return client
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    batchClients.set(endpoint, {
      client: null as any,
      lastError: err,
      lastReconnectAttempt: now,
    })
    log.error("Failed to create batch authz gRPC client", {
      error: err.message,
      stack: err.stack,
    })
    throw err
  }
}

/**
 * Batch-check authorization for multiple agent/permission pairs in a single
 * RPC call. Requires the adapter to implement
 * opencode.authz.v1.BatchAuthorizationService/BatchCheck.
 *
 * Falls back gracefully: callers should catch errors and use individual checks.
 *
 * @param config   ext_authz configuration (batchEndpoint defaults to endpoint)
 * @param principal  The authenticated caller identity
 * @param items    Agent/permission pairs to check
 * @returns Array of results in the same order as items
 */
export async function batchCheckAuthorization(
  config: ExtAuthzConfig,
  principal: string,
  items: BatchCheckItem[],
): Promise<BatchCheckResult[]> {
  const startTime = Date.now()
  const timeout = parseTimeoutMs(config.timeout) * 2 // double timeout for batch

  try {
    const client = await getBatchClient(config)

    const request = {
      principal,
      items: items.map((item) => ({
        agentId: item.agentId,
        permission: item.permission,
      })),
    }

    const response = await new Promise<any>((resolve, reject) => {
      client.batchCheck(
        request,
        { deadline: Date.now() + timeout },
        (err: Error | null, response: any) => {
          if (err) return reject(err)
          resolve(response)
        },
      )
    })

    const latencyMs = Date.now() - startTime
    const results: BatchCheckResult[] = (response.results ?? []).map((r: any) => ({
      agentId: r.agentId ?? "",
      allowed: r.allowed ?? false,
      error: r.error || undefined,
    }))

    log.debug("batch authz completed", {
      principal: principal.slice(0, 30),
      itemCount: items.length,
      allowed: results.filter((r) => r.allowed).length,
      latencyMs,
    })

    return results
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const stack = error instanceof Error ? error.stack : undefined

    // Mark client as failed for reconnection
    if (
      error instanceof Error &&
      (message.includes("UNAVAILABLE") ||
        message.includes("ECONNREFUSED") ||
        message.includes("DEADLINE_EXCEEDED") ||
        message.includes("UNIMPLEMENTED"))
    ) {
      const endpoint = config.batchEndpoint ?? config.endpoint
      const entry = batchClients.get(endpoint)
      if (entry) {
        entry.lastError = error
      }
    }

    log.warn("batch authz call failed", {
      error: message,
      stack,
      endpoint: sanitizeEndpoint(config.batchEndpoint ?? config.endpoint),
      latencyMs: Date.now() - startTime,
      itemCount: items.length,
    })

    throw error // Let caller fall back to individual checks
  }
}

/**
 * Close all ext_authz gRPC clients. Call this on shutdown.
 */
export function closeAllClients(): void {
  for (const [endpoint, entry] of clients) {
    try {
      entry.client?.close()
    } catch {
      /* ignore */
    }
  }
  clients.clear()
  for (const [endpoint, entry] of batchClients) {
    try {
      entry.client?.close()
    } catch {
      /* ignore */
    }
  }
  batchClients.clear()
  log.info("ext_authz: all gRPC clients closed")
}

/**
 * Build an ExtAuthzRequestContext from a standard HTTP Request and optional
 * metadata. Convenience helper for use in the auth pipeline.
 */
export function requestToExtAuthzContext(
  req: Request,
  opts?: {
    agentId?: string
    skill?: string
    sessionId?: string
    authStrategy?: string
    withBody?: { maxBytes: number; allowPartial: boolean }
  },
): ExtAuthzRequestContext {
  const url = new URL(req.url)
  const headers: Record<string, string> = {}
  req.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value
  })

  return {
    method: req.method,
    path: url.pathname + url.search,
    headers,
    host: url.host,
    scheme: url.protocol.replace(":", ""),
    sourcePrincipal: "",
    destinationService: opts?.agentId ?? "",
    agentId: opts?.agentId,
    skill: opts?.skill,
    sessionId: opts?.sessionId,
    authStrategy: opts?.authStrategy,
    // Body is populated by the caller if withRequestBody is configured
  }
}
