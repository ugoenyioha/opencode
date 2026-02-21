import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import * as grpc from "@grpc/grpc-js"
import * as protoLoader from "@grpc/proto-loader"
import path from "path"
import { checkAuthorization, closeAllClients, type ExtAuthzConfig, type ExtAuthzRequestContext } from "../../src/server/ext-authz"
import type { AuthnResult } from "../../src/server/auth-policy"

// ---------------------------------------------------------------------------
// Mock gRPC ext_authz server
// ---------------------------------------------------------------------------

const PROTO_PATH = path.resolve(__dirname, "../../src/server/proto/ext_authz.proto")
const GOOGLE_RPC_PATH = path.resolve(__dirname, "../../src/server/proto")

let mockServer: grpc.Server
let mockPort: number
let checkBehavior: (call: any, callback: any) => void

async function startMockServer(): Promise<number> {
  const packageDefinition = await protoLoader.load(PROTO_PATH, {
    keepCase: false,
    longs: Number,
    enums: Number,
    defaults: true,
    oneofs: true,
    includeDirs: [GOOGLE_RPC_PATH],
  })

  const proto = grpc.loadPackageDefinition(packageDefinition) as any
  const AuthorizationService = proto.envoy.service.auth.v3.Authorization

  mockServer = new grpc.Server()
  mockServer.addService(AuthorizationService.service, {
    check: (call: any, callback: any) => {
      checkBehavior(call, callback)
    },
  })

  return new Promise((resolve, reject) => {
    mockServer.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createInsecure(),
      (err, port) => {
        if (err) return reject(err)
        resolve(port)
      },
    )
  })
}

function stopMockServer(): Promise<void> {
  return new Promise((resolve) => {
    if (mockServer) {
      mockServer.tryShutdown(() => resolve())
    } else {
      resolve()
    }
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<ExtAuthzConfig>): ExtAuthzConfig {
  return {
    endpoint: `grpc://127.0.0.1:${mockPort}`,
    timeout: 2000,
    failOpen: false,
    ...overrides,
  }
}

function makeContext(overrides?: Partial<ExtAuthzRequestContext>): ExtAuthzRequestContext {
  return {
    method: "POST",
    path: "/a2a/test-agent/message/stream",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-token",
      host: "localhost:8080",
    },
    host: "localhost:8080",
    scheme: "http",
    agentId: "test-agent",
    ...overrides,
  }
}

function makeAuthn(overrides?: Partial<AuthnResult>): AuthnResult {
  return {
    ok: true,
    strategy: "spiffe",
    principal: "spiffe://trust.domain/ns/default/sa/caller",
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("ext_authz gRPC client", () => {
  beforeAll(async () => {
    mockPort = await startMockServer()
  })

  afterAll(async () => {
    closeAllClients()
    await stopMockServer()
  })

  describe("allow decisions", () => {
    test("allows request when server returns status code 0 (OK)", async () => {
      checkBehavior = (_call: any, callback: any) => {
        callback(null, {
          status: { code: 0, message: "" },
        })
      }

      const decision = await checkAuthorization(makeConfig(), makeContext(), makeAuthn())

      expect(decision.allowed).toBe(true)
      expect(decision.statusCode).toBe(0)
      expect(decision.reason).toBe("ext_authz_ok")
      expect(decision.latencyMs).toBeGreaterThanOrEqual(0)
    })

    test("returns response headers from OkHttpResponse", async () => {
      checkBehavior = (_call: any, callback: any) => {
        callback(null, {
          status: { code: 0, message: "" },
          okResponse: {
            headers: [
              { header: { key: "x-authz-context", value: "allowed" } },
              { header: { key: "x-authz-principal", value: "spiffe://trust.domain/caller" } },
            ],
            headersToRemove: ["authorization"],
          },
        })
      }

      const decision = await checkAuthorization(makeConfig(), makeContext(), makeAuthn())

      expect(decision.allowed).toBe(true)
      expect(decision.responseHeaders).toEqual({
        "x-authz-context": "allowed",
        "x-authz-principal": "spiffe://trust.domain/caller",
      })
      expect(decision.headersToRemove).toEqual(["authorization"])
    })
  })

  describe("deny decisions", () => {
    test("denies request when server returns non-zero status code", async () => {
      // Close existing client so it reconnects to pick up new behavior
      closeAllClients()

      checkBehavior = (_call: any, callback: any) => {
        callback(null, {
          status: { code: 7, message: "PERMISSION_DENIED: caller not allowed" },
        })
      }

      const decision = await checkAuthorization(makeConfig(), makeContext(), makeAuthn())

      expect(decision.allowed).toBe(false)
      expect(decision.statusCode).toBe(7)
      expect(decision.reason).toBe("PERMISSION_DENIED: caller not allowed")
    })

    test("extracts HTTP status from DeniedHttpResponse", async () => {
      closeAllClients()

      checkBehavior = (_call: any, callback: any) => {
        callback(null, {
          status: { code: 7, message: "denied" },
          deniedResponse: {
            status: { code: 403 },
            body: "Access denied: insufficient permissions",
          },
        })
      }

      const decision = await checkAuthorization(makeConfig(), makeContext(), makeAuthn())

      expect(decision.allowed).toBe(false)
      expect(decision.statusCode).toBe(403)
      expect(decision.reason).toBe("Access denied: insufficient permissions")
    })
  })

  describe("context forwarding", () => {
    test("forwards source principal from authn result", async () => {
      closeAllClients()
      let receivedRequest: any = null

      checkBehavior = (call: any, callback: any) => {
        receivedRequest = call.request
        callback(null, { status: { code: 0, message: "" } })
      }

      const authn = makeAuthn({ principal: "spiffe://trust.domain/ns/prod/sa/my-service" })
      await checkAuthorization(makeConfig(), makeContext(), authn)

      expect(receivedRequest).toBeTruthy()
      expect(receivedRequest.attributes.source.principal).toBe("spiffe://trust.domain/ns/prod/sa/my-service")
      expect(receivedRequest.attributes.contextExtensions["opencode.principal"]).toBe(
        "spiffe://trust.domain/ns/prod/sa/my-service",
      )
      expect(receivedRequest.attributes.contextExtensions["opencode.authn_strategy"]).toBe("spiffe")
    })

    test("forwards agent ID and static context extensions", async () => {
      closeAllClients()
      let receivedRequest: any = null

      checkBehavior = (call: any, callback: any) => {
        receivedRequest = call.request
        callback(null, { status: { code: 0, message: "" } })
      }

      const config = makeConfig({
        contextExtensions: {
          environment: "production",
          cluster: "us-east-1",
        },
      })

      const context = makeContext({ agentId: "code-reviewer", skill: "code-review" })
      await checkAuthorization(config, context, makeAuthn())

      expect(receivedRequest.attributes.contextExtensions["opencode.agent"]).toBe("code-reviewer")
      expect(receivedRequest.attributes.contextExtensions["opencode.skill"]).toBe("code-review")
      expect(receivedRequest.attributes.contextExtensions["environment"]).toBe("production")
      expect(receivedRequest.attributes.contextExtensions["cluster"]).toBe("us-east-1")
    })

    test("forwards HTTP method, path, and headers", async () => {
      closeAllClients()
      let receivedRequest: any = null

      checkBehavior = (call: any, callback: any) => {
        receivedRequest = call.request
        callback(null, { status: { code: 0, message: "" } })
      }

      const context = makeContext({
        method: "POST",
        path: "/a2a/my-agent/message/stream?foo=bar",
        host: "agent.example.com",
        headers: {
          "content-type": "application/json",
          "x-request-id": "req-123",
        },
      })

      await checkAuthorization(makeConfig(), context, makeAuthn())

      const http = receivedRequest.attributes.request.http
      expect(http.method).toBe("POST")
      expect(http.path).toBe("/a2a/my-agent/message/stream?foo=bar")
      expect(http.host).toBe("agent.example.com")
      expect(http.headers["content-type"]).toBe("application/json")
      expect(http.headers["x-request-id"]).toBe("req-123")
      expect(http.id).toBe("req-123") // x-request-id maps to id field
    })
  })

  describe("error handling", () => {
    test("fail-closed: denies on gRPC error by default", async () => {
      closeAllClients()

      checkBehavior = (_call: any, callback: any) => {
        callback({
          code: grpc.status.UNAVAILABLE,
          message: "Connection refused",
        })
      }

      const decision = await checkAuthorization(
        makeConfig({ failOpen: false }),
        makeContext(),
        makeAuthn(),
      )

      expect(decision.allowed).toBe(false)
      expect(decision.reason).toContain("ext_authz_error")
    })

    test("fail-open: allows on gRPC error when configured", async () => {
      closeAllClients()

      checkBehavior = (_call: any, callback: any) => {
        callback({
          code: grpc.status.UNAVAILABLE,
          message: "Connection refused",
        })
      }

      const decision = await checkAuthorization(
        makeConfig({ failOpen: true }),
        makeContext(),
        makeAuthn(),
      )

      expect(decision.allowed).toBe(true)
      expect(decision.reason).toContain("ext_authz_error_failopen")
    })

    test("times out with deadline exceeded", async () => {
      closeAllClients()

      checkBehavior = (_call: any, _callback: any) => {
        // Never respond — let the deadline expire
      }

      const decision = await checkAuthorization(
        makeConfig({ timeout: 100 }), // Very short timeout
        makeContext(),
        makeAuthn(),
      )

      expect(decision.allowed).toBe(false)
      expect(decision.reason).toContain("ext_authz_error")
      expect(decision.latencyMs).toBeGreaterThanOrEqual(90) // Close to timeout
    })

    test("handles unreachable server (fail-closed)", async () => {
      closeAllClients()

      const decision = await checkAuthorization(
        {
          endpoint: "grpc://127.0.0.1:1", // Port 1 — guaranteed unreachable
          timeout: 500,
          failOpen: false,
        },
        makeContext(),
        makeAuthn(),
      )

      expect(decision.allowed).toBe(false)
      expect(decision.reason).toContain("ext_authz_error")
    })

    test("handles unreachable server (fail-open)", async () => {
      closeAllClients()

      const decision = await checkAuthorization(
        {
          endpoint: "grpc://127.0.0.1:1", // Port 1 — guaranteed unreachable
          timeout: 500,
          failOpen: true,
        },
        makeContext(),
        makeAuthn(),
      )

      expect(decision.allowed).toBe(true)
      expect(decision.reason).toContain("ext_authz_error_failopen")
    })
  })

  describe("request body forwarding", () => {
    test("forwards request body when withRequestBody is configured", async () => {
      closeAllClients()
      let receivedRequest: any = null

      checkBehavior = (call: any, callback: any) => {
        receivedRequest = call.request
        callback(null, { status: { code: 0, message: "" } })
      }

      const config = makeConfig({
        withRequestBody: { maxBytes: 1024, allowPartial: true },
      })

      const context = makeContext({ body: '{"message": "hello"}' })
      await checkAuthorization(config, context, makeAuthn())

      expect(receivedRequest.attributes.request.http.body).toBe('{"message": "hello"}')
    })

    test("truncates body when exceeds maxBytes and allowPartial", async () => {
      closeAllClients()
      let receivedRequest: any = null

      checkBehavior = (call: any, callback: any) => {
        receivedRequest = call.request
        callback(null, { status: { code: 0, message: "" } })
      }

      const config = makeConfig({
        withRequestBody: { maxBytes: 10, allowPartial: true },
      })

      const longBody = "x".repeat(100)
      const context = makeContext({ body: longBody })
      await checkAuthorization(config, context, makeAuthn())

      expect(receivedRequest.attributes.request.http.body).toBe("x".repeat(10))
    })

    test("does not forward body when withRequestBody is not configured", async () => {
      closeAllClients()
      let receivedRequest: any = null

      checkBehavior = (call: any, callback: any) => {
        receivedRequest = call.request
        callback(null, { status: { code: 0, message: "" } })
      }

      const context = makeContext({ body: '{"secret": "data"}' })
      await checkAuthorization(makeConfig(), context, makeAuthn()) // No withRequestBody

      // Body should be empty (not forwarded)
      expect(receivedRequest.attributes.request.http.body).toBeFalsy()
    })
  })

  describe("dynamic metadata", () => {
    test("returns dynamic metadata from response", async () => {
      closeAllClients()

      checkBehavior = (_call: any, callback: any) => {
        callback(null, {
          status: { code: 0, message: "" },
          dynamicMetadata: {
            fields: {
              "decision_id": { stringValue: "dec-123" },
              "policy": { stringValue: "allow-all" },
            },
          },
        })
      }

      const decision = await checkAuthorization(makeConfig(), makeContext(), makeAuthn())

      expect(decision.allowed).toBe(true)
      expect(decision.dynamicMetadata).toBeTruthy()
    })
  })

  describe("authn result threading", () => {
    test("works without authn result (public endpoint)", async () => {
      closeAllClients()
      let receivedRequest: any = null

      checkBehavior = (call: any, callback: any) => {
        receivedRequest = call.request
        callback(null, { status: { code: 0, message: "" } })
      }

      // No authn result (undefined) — simulates public endpoint
      await checkAuthorization(makeConfig(), makeContext(), undefined)

      expect(receivedRequest.attributes.source.principal).toBe("")
      expect(receivedRequest.attributes.contextExtensions["opencode.principal"]).toBeUndefined()
    })

    test("threads API key authn strategy", async () => {
      closeAllClients()
      let receivedRequest: any = null

      checkBehavior = (call: any, callback: any) => {
        receivedRequest = call.request
        callback(null, { status: { code: 0, message: "" } })
      }

      const authn = makeAuthn({ strategy: "api-key", principal: "api-key" })
      await checkAuthorization(makeConfig(), makeContext(), authn)

      expect(receivedRequest.attributes.contextExtensions["opencode.authn_strategy"]).toBe("api-key")
      expect(receivedRequest.attributes.contextExtensions["opencode.principal"]).toBe("api-key")
    })
  })

  describe("timeout string parsing", () => {
    test("accepts numeric timeout in milliseconds", async () => {
      closeAllClients()

      checkBehavior = (_call: any, callback: any) => {
        callback(null, { status: { code: 0, message: "" } })
      }

      const decision = await checkAuthorization(
        makeConfig({ timeout: 2000 }),
        makeContext(),
        makeAuthn(),
      )
      expect(decision.allowed).toBe(true)
    })

    test("accepts string timeout '500ms'", async () => {
      closeAllClients()

      checkBehavior = (_call: any, callback: any) => {
        callback(null, { status: { code: 0, message: "" } })
      }

      const decision = await checkAuthorization(
        makeConfig({ timeout: "500ms" as any }),
        makeContext(),
        makeAuthn(),
      )
      expect(decision.allowed).toBe(true)
    })

    test("accepts string timeout '2s'", async () => {
      closeAllClients()

      checkBehavior = (_call: any, callback: any) => {
        callback(null, { status: { code: 0, message: "" } })
      }

      const decision = await checkAuthorization(
        makeConfig({ timeout: "2s" as any }),
        makeContext(),
        makeAuthn(),
      )
      expect(decision.allowed).toBe(true)
    })
  })
})
