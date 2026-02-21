/**
 * Envoy ext_authz v3 gRPC client for OpenCode.
 *
 * Implements the client side of the `envoy.service.auth.v3.Authorization/Check`
 * gRPC protocol. Compatible with any ext_authz server (OPA, SpiceDB adapters,
 * Cedar adapters, custom servers).
 *
 * Design decisions:
 *   - Uses @grpc/proto-loader to load a self-contained proto at runtime
 *     (no codegen, no 25-file dependency tree).
 *   - Lazy-loads gRPC + proto deps to avoid import errors when ext_authz
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
import path from "path"
import fs from "fs"
import os from "os"
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
// Lazy-loaded gRPC + proto-loader deps
// ---------------------------------------------------------------------------

let _grpc: typeof import("@grpc/grpc-js") | null = null
let _protoLoader: typeof import("@grpc/proto-loader") | null = null
let _authzServiceDef: any = null

async function loadGrpc() {
  if (!_grpc) {
    _grpc = await import("@grpc/grpc-js")
  }
  return _grpc
}

// Embedded proto contents — ensures the proto files are available even in
// compiled binaries (Bun.build compile) where __dirname doesn't resolve
// to the source tree.
const EXT_AUTHZ_PROTO = `syntax = "proto3";
package envoy.service.auth.v3;
import "google/protobuf/struct.proto";
import "google/protobuf/timestamp.proto";
import "google/protobuf/wrappers.proto";
import "google/rpc/status.proto";
service Authorization { rpc Check(CheckRequest) returns (CheckResponse) {} }
message CheckRequest { AttributeContext attributes = 1; }
message AttributeContext {
  message Peer { Address address = 1; string service = 2; map<string, string> labels = 3; string principal = 4; string certificate = 5; }
  message Request { google.protobuf.Timestamp time = 1; HttpRequest http = 2; }
  message HttpRequest { string id = 1; string method = 2; map<string, string> headers = 3; string path = 4; string host = 5; string scheme = 6; string query = 7; string fragment = 8; int64 size = 9; string protocol = 10; string body = 11; bytes raw_body = 12; }
  message TLSSession { string sni = 1; }
  Peer source = 1; Peer destination = 2; Request request = 4; map<string, string> context_extensions = 10;
  google.protobuf.Struct metadata_context = 11; google.protobuf.Struct route_metadata_context = 13; TLSSession tls_session = 12;
}
message Address { oneof address { SocketAddress socket_address = 1; Pipe pipe = 3; } }
message SocketAddress { enum Protocol { TCP = 0; UDP = 1; } Protocol protocol = 1; string address = 2; oneof port_specifier { uint32 port_value = 4; string named_port = 5; } string resolver_name = 6; string ipv4_compat = 7; }
message Pipe { string path = 1; uint32 mode = 2; }
message CheckResponse { google.rpc.Status status = 1; oneof http_response { DeniedHttpResponse denied_response = 2; OkHttpResponse ok_response = 3; DeniedHttpResponse error_response = 5; } google.protobuf.Struct dynamic_metadata = 4; }
message DeniedHttpResponse { HttpStatus status = 1; repeated HeaderValueOption headers = 2; string body = 3; }
message OkHttpResponse { repeated HeaderValueOption headers = 2; repeated string headers_to_remove = 5; repeated HeaderValueOption response_headers_to_add = 6; repeated QueryParameter query_parameters_to_set = 7; repeated string query_parameters_to_remove = 8; }
message HttpStatus { int32 code = 1; }
message HeaderValueOption { HeaderValue header = 1; google.protobuf.BoolValue append = 2; bool append_action = 3; bool keep_empty_value = 4; }
message HeaderValue { string key = 1; string value = 2; bytes raw_value = 3; }
message QueryParameter { string key = 1; string value = 2; }
`

const GOOGLE_RPC_STATUS_PROTO = `syntax = "proto3";
package google.rpc;
import "google/protobuf/any.proto";
message Status { int32 code = 1; string message = 2; repeated google.protobuf.Any details = 3; }
`

let _protoDir: string | null = null

/**
 * Stage embedded proto files to a temp directory so @grpc/proto-loader can
 * resolve them. The directory is reused across calls and cleaned up on exit.
 */
function getProtoDir(): string {
  if (_protoDir) return _protoDir
  _protoDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-ext-authz-"))
  const googleRpcDir = path.join(_protoDir, "google", "rpc")
  fs.mkdirSync(googleRpcDir, { recursive: true })
  fs.writeFileSync(path.join(_protoDir, "ext_authz.proto"), EXT_AUTHZ_PROTO)
  fs.writeFileSync(path.join(googleRpcDir, "status.proto"), GOOGLE_RPC_STATUS_PROTO)
  return _protoDir
}

async function loadProto() {
  if (_authzServiceDef) return _authzServiceDef

  if (!_protoLoader) {
    _protoLoader = await import("@grpc/proto-loader")
  }

  const protoDir = getProtoDir()
  const PROTO_PATH = path.join(protoDir, "ext_authz.proto")

  const packageDefinition = await _protoLoader.load(PROTO_PATH, {
    keepCase: false, // Convert to camelCase
    longs: Number,
    enums: Number,
    defaults: true,
    oneofs: true,
    includeDirs: [
      protoDir,
      // proto-loader resolves google/protobuf/* from protobufjs
    ],
  })

  const grpc = await loadGrpc()
  const protoDescriptor = grpc.loadPackageDefinition(packageDefinition) as any
  _authzServiceDef = protoDescriptor.envoy.service.auth.v3.Authorization

  return _authzServiceDef
}

// ---------------------------------------------------------------------------
// Client management
// ---------------------------------------------------------------------------

// Dynamic gRPC client from proto-loader — use `any` because method signatures
// are generated at runtime from the .proto file, not known at compile time.
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

  // Parse endpoint: "grpc://host:port" → "host:port"
  let target = endpoint
  if (target.startsWith("grpc://")) {
    target = target.slice("grpc://".length)
  } else if (target.startsWith("dns:///")) {
    // Keep dns:/// prefix — gRPC understands it natively
  }

  // Close stale client if any
  if (entry?.client) {
    try {
      entry.client.close()
    } catch {
      /* ignore */
    }
  }

  try {
    // Determine credentials: TLS by default, insecure for localhost/plaintext
    const isInsecure =
      target.startsWith("localhost") ||
      target.startsWith("127.0.0.1") ||
      target.startsWith("[::1]") ||
      target.includes("://localhost")

    const creds = isInsecure
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
    log.error("Failed to create ext_authz gRPC client", { error: err.message })
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

// ---------------------------------------------------------------------------
// Batch authorization: opencode.authz.v1.BatchAuthorizationService/BatchCheck
// ---------------------------------------------------------------------------

const BATCH_AUTHZ_PROTO = `syntax = "proto3";
package opencode.authz.v1;
service BatchAuthorizationService { rpc BatchCheck(BatchCheckRequest) returns (BatchCheckResponse) {} }
message BatchCheckRequest { string principal = 1; repeated BatchCheckItemMsg items = 2; }
message BatchCheckItemMsg { string agent_id = 1; string permission = 2; }
message BatchCheckResponse { repeated BatchCheckResultMsg results = 1; }
message BatchCheckResultMsg { string agent_id = 1; bool allowed = 2; string error = 3; }
`

let _batchServiceDef: any = null
const batchClients = new Map<string, {
  client: any
  lastError: Error | null
  lastReconnectAttempt: number
}>()

async function loadBatchProto() {
  if (_batchServiceDef) return _batchServiceDef

  if (!_protoLoader) {
    _protoLoader = await import("@grpc/proto-loader")
  }

  const protoDir = getProtoDir()
  const batchProtoPath = path.join(protoDir, "batch_authz.proto")
  fs.writeFileSync(batchProtoPath, BATCH_AUTHZ_PROTO)

  const packageDefinition = await _protoLoader.load(batchProtoPath, {
    keepCase: false,
    longs: Number,
    enums: Number,
    defaults: true,
    oneofs: true,
    includeDirs: [protoDir],
  })

  const grpc = await loadGrpc()
  const protoDescriptor = grpc.loadPackageDefinition(packageDefinition) as any
  _batchServiceDef = protoDescriptor.opencode.authz.v1.BatchAuthorizationService

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

  let target = endpoint
  if (target.startsWith("grpc://")) {
    target = target.slice("grpc://".length)
  }

  if (entry?.client) {
    try { entry.client.close() } catch { /* ignore */ }
  }

  try {
    const isInsecure =
      target.startsWith("localhost") ||
      target.startsWith("127.0.0.1") ||
      target.startsWith("[::1]") ||
      target.includes("://localhost")

    const creds = isInsecure
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
