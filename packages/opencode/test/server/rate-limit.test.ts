import { describe, test, expect, beforeEach } from "bun:test"
import { Hono } from "hono"
import { INTERNAL_CLIENT_IP_HEADER, rateLimitMiddleware, _resetStore } from "../../src/server/rate-limit"

// Helper: build a minimal Hono app with the rate-limit middleware wired in.
function makeApp(rpm: number, trustProxy = false) {
  const app = new Hono()
  app.use(rateLimitMiddleware(async () => rpm, trustProxy))
  app.get("/ping", (c) => c.json({ ok: true }))
  return app
}

// Helper: fire a GET /ping with optional headers, return the Response.
async function req(app: Hono, headers: Record<string, string> = {}): Promise<Response> {
  return app.request("/ping", { headers })
}

beforeEach(() => {
  _resetStore()
})

describe("rate-limit middleware", () => {
  test("allows requests under the limit", async () => {
    const app = makeApp(5)
    for (let i = 0; i < 5; i++) {
      const r = await req(app, { "x-api-key": "test-key" })
      expect(r.status).toBe(200)
    }
  })

  test("returns 429 on the request that exceeds the limit", async () => {
    const app = makeApp(3)
    for (let i = 0; i < 3; i++) await req(app, { "x-api-key": "k" })
    const r = await req(app, { "x-api-key": "k" })
    expect(r.status).toBe(429)
  })

  test("429 body is deterministic JSON with required fields", async () => {
    const app = makeApp(1)
    await req(app, { "x-api-key": "k" }) // consume the one allowed request
    const r = await req(app, { "x-api-key": "k" })
    expect(r.status).toBe(429)
    const body = await r.json()
    expect(body.error).toBe("rate_limit_exceeded")
    expect(typeof body.message).toBe("string")
    expect(typeof body.retry_after).toBe("number")
    expect(body.retry_after).toBeGreaterThan(0)
    expect(body.retry_after).toBeLessThanOrEqual(60)
  })

  test("429 response includes Retry-After and X-RateLimit headers", async () => {
    const app = makeApp(1)
    await req(app, { "x-api-key": "k" })
    const r = await req(app, { "x-api-key": "k" })
    expect(r.headers.get("Retry-After")).toBeTruthy()
    expect(r.headers.get("X-RateLimit-Limit")).toBe("1")
    expect(r.headers.get("X-RateLimit-Remaining")).toBe("0")
  })

  test("identity: x-api-key takes priority over Authorization", async () => {
    const app = makeApp(2)
    // One request with both headers - should be counted under x-api-key bucket
    await req(app, { "x-api-key": "keyA", authorization: "Bearer tokenX" })
    await req(app, { "x-api-key": "keyA", authorization: "Bearer tokenX" })
    const limited = await req(app, { "x-api-key": "keyA", authorization: "Bearer tokenX" })
    expect(limited.status).toBe(429)

    // Different API key → separate bucket, still allowed
    const other = await req(app, { "x-api-key": "keyB", authorization: "Bearer tokenX" })
    expect(other.status).toBe(200)
  })

  test("identity: Authorization hash used when no x-api-key", async () => {
    const app = makeApp(1)
    await req(app, { authorization: "Bearer abc123" })
    const r = await req(app, { authorization: "Bearer abc123" })
    expect(r.status).toBe(429)

    // Different token → separate bucket
    const other = await req(app, { authorization: "Bearer xyz789" })
    expect(other.status).toBe(200)
  })

  test("identity: IP fallback when no auth headers (trustProxy=true)", async () => {
    const app = makeApp(2, true)
    await req(app, { "x-forwarded-for": "1.2.3.4" })
    await req(app, { "x-forwarded-for": "1.2.3.4" })
    const limited = await req(app, { "x-forwarded-for": "1.2.3.4" })
    expect(limited.status).toBe(429)

    // Different IP → separate bucket
    const other = await req(app, { "x-forwarded-for": "5.6.7.8" })
    expect(other.status).toBe(200)
  })

  test("different identity keys have independent counters", async () => {
    const app = makeApp(2)
    // Fill up keyA
    await req(app, { "x-api-key": "keyA" })
    await req(app, { "x-api-key": "keyA" })
    expect((await req(app, { "x-api-key": "keyA" })).status).toBe(429)

    // keyB is unaffected
    expect((await req(app, { "x-api-key": "keyB" })).status).toBe(200)
    expect((await req(app, { "x-api-key": "keyB" })).status).toBe(200)
    expect((await req(app, { "x-api-key": "keyB" })).status).toBe(429)
  })

  test("rpm=0 disables rate limiting entirely", async () => {
    const app = makeApp(0)
    for (let i = 0; i < 200; i++) {
      const r = await req(app, { "x-api-key": "k" })
      expect(r.status).toBe(200)
    }
  })

  test("no-auth no-proxy request falls back to 'unknown' IP bucket", async () => {
    const app = makeApp(2)
    await req(app) // no headers – ip = ""
    await req(app)
    const r = await req(app)
    expect(r.status).toBe(429)
  })

  test("no-auth no-proxy request uses internal socket IP header when available", async () => {
    const app = makeApp(2)
    await req(app, { [INTERNAL_CLIENT_IP_HEADER]: "10.0.0.1" })
    await req(app, { [INTERNAL_CLIENT_IP_HEADER]: "10.0.0.1" })
    expect((await req(app, { [INTERNAL_CLIENT_IP_HEADER]: "10.0.0.1" })).status).toBe(429)

    expect((await req(app, { [INTERNAL_CLIENT_IP_HEADER]: "10.0.0.2" })).status).toBe(200)
  })
})
