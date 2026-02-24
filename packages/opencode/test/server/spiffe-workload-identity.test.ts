import { describe, expect, mock, test } from "bun:test"

let mode: "success" | "error" = "success"
let calls = 0
let metadataSetCalled = false

mock.module("@grpc/grpc-js", () => {
  class Metadata {
    set(key: string, value: string) {
      if (key === "workload.spiffe.io" && value === "true") metadataSetCalled = true
    }
  }

  class Client {
    constructor(_endpoint: string, _credentials: unknown) {}

    close() {}

    makeServerStreamRequest() {
      calls += 1
      const handlers: Record<string, (...args: any[]) => void> = {}
      const call = {
        on(event: string, fn: (...args: any[]) => void) {
          handlers[event] = fn
          return call
        },
        cancel() {},
      }

      queueMicrotask(() => {
        if (mode === "error") {
          handlers.error?.(new Error("stream failed"))
          return
        }
        handlers.data?.({ svids: [{ spiffeId: "spiffe://trust.domain/ns/default/sa/sidecar" }] })
        handlers.end?.()
      })

      return call
    }
  }

  return {
    Client,
    Metadata,
    credentials: {
      createInsecure() {
        return {}
      },
    },
  }
})

const spiffe = await import("../../src/server/spiffe")

describe("fetchLocalWorkloadIdentity", () => {
  test("returns null when SPIFFE endpoint is missing", async () => {
    delete process.env.SPIFFE_ENDPOINT_SOCKET
    mode = "success"
    const result = await spiffe.fetchLocalWorkloadIdentity()
    expect(result).toBeNull()
  })

  test("returns null on stream error", async () => {
    process.env.SPIFFE_ENDPOINT_SOCKET = "unix:///tmp/spire-agent.sock"
    mode = "error"
    const result = await spiffe.fetchLocalWorkloadIdentity()
    expect(result).toBeNull()
  })

  test("returns and caches workload principal", async () => {
    process.env.SPIFFE_ENDPOINT_SOCKET = "unix:///tmp/spire-agent.sock"
    mode = "success"
    calls = 0
    metadataSetCalled = false

    const first = await spiffe.fetchLocalWorkloadIdentity()
    const second = await spiffe.fetchLocalWorkloadIdentity()

    expect(first).toBe("spiffe://trust.domain/ns/default/sa/sidecar")
    expect(second).toBe("spiffe://trust.domain/ns/default/sa/sidecar")
    expect(calls).toBe(1)
    expect(metadataSetCalled).toBe(true)
  })
})
