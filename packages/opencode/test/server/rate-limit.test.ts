import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Hono } from "hono"
import path from "path"
import { INTERNAL_CLIENT_IP_HEADER, rateLimitMiddleware } from "../../src/server/rate-limit"
import type { RateLimitStore } from "../../src/server/rate-limit/store"
import { MemoryRateLimitStore, SqliteRateLimitStore } from "../../src/server/rate-limit/store"
import { tmpdir } from "../fixture/fixture"

type StoreContext = {
  store: RateLimitStore
  cleanup: () => Promise<void>
}

type StoreBuilder = {
  name: string
  setup: () => Promise<StoreContext>
}

const builders: StoreBuilder[] = [
  {
    name: "memory",
    setup: async () => {
      const store = new MemoryRateLimitStore()
      return {
        store,
        cleanup: async () => {
          store.reset()
        },
      }
    },
  },
  {
    name: "sqlite",
    setup: async () => {
      const dir = await tmpdir()
      const store = new SqliteRateLimitStore({ path: path.join(dir.path, "rate-limit.db") })
      return {
        store,
        cleanup: async () => {
          store.close()
          const dispose = (dir as any)[Symbol.asyncDispose] as (() => Promise<void>) | undefined
          if (dispose) await dispose.call(dir)
        },
      }
    },
  },
]

function makeApp(rpm: number, store: RateLimitStore, trustProxy = false, now?: () => number) {
  const app = new Hono()
  app.use(rateLimitMiddleware(async () => rpm, trustProxy, { store, now }))
  app.get("/ping", (c) => c.json({ ok: true }))
  return app
}

async function req(app: Hono, headers: Record<string, string> = {}) {
  return app.request("/ping", { headers })
}

builders.forEach(({ name, setup }) => {
  describe(`rate-limit middleware (${name})`, () => {
    let ctx: StoreContext

    beforeEach(async () => {
      ctx = await setup()
    })

    afterEach(async () => {
      await ctx.cleanup()
    })

    test("allows requests under the limit", async () => {
      const app = makeApp(5, ctx.store)
      for (let i = 0; i < 5; i++) {
        const res = await req(app, { "x-api-key": "test-key" })
        expect(res.status).toBe(200)
      }
    })

    test("returns 429 on the request that exceeds the limit", async () => {
      const app = makeApp(3, ctx.store)
      for (let i = 0; i < 3; i++) await req(app, { "x-api-key": "k" })
      const res = await req(app, { "x-api-key": "k" })
      expect(res.status).toBe(429)
    })

    test("429 body is deterministic JSON with required fields", async () => {
      const fixed = Date.UTC(2023, 0, 1, 0, 0, 30)
      const app = makeApp(1, ctx.store, false, () => fixed)
      await req(app, { "x-api-key": "k" })
      const res = await req(app, { "x-api-key": "k" })
      const body = await res.json()
      expect(res.status).toBe(429)
      expect(body.error).toBe("rate_limit_exceeded")
      expect(body.retry_after).toBe(30)
      expect(res.headers.get("Retry-After")).toBe("30")
    })

    test("429 response includes Retry-After and X-RateLimit headers", async () => {
      const app = makeApp(1, ctx.store)
      await req(app, { "x-api-key": "k" })
      const res = await req(app, { "x-api-key": "k" })
      expect(res.headers.get("Retry-After")).toBeTruthy()
      expect(res.headers.get("X-RateLimit-Limit")).toBe("1")
      expect(res.headers.get("X-RateLimit-Remaining")).toBe("0")
    })

    test("identity: x-api-key takes priority over Authorization", async () => {
      const app = makeApp(2, ctx.store)
      await req(app, { "x-api-key": "keyA", authorization: "Bearer tokenX" })
      await req(app, { "x-api-key": "keyA", authorization: "Bearer tokenX" })
      const limited = await req(app, { "x-api-key": "keyA", authorization: "Bearer tokenX" })
      expect(limited.status).toBe(429)

      const other = await req(app, { "x-api-key": "keyB", authorization: "Bearer tokenX" })
      expect(other.status).toBe(200)
    })

    test("identity: Authorization hash used when no x-api-key", async () => {
      const app = makeApp(1, ctx.store)
      await req(app, { authorization: "Bearer abc123" })
      const res = await req(app, { authorization: "Bearer abc123" })
      expect(res.status).toBe(429)

      const other = await req(app, { authorization: "Bearer xyz789" })
      expect(other.status).toBe(200)
    })

    test("identity: IP fallback when no auth headers (trustProxy=true)", async () => {
      const app = makeApp(2, ctx.store, true)
      await req(app, { "x-forwarded-for": "1.2.3.4" })
      await req(app, { "x-forwarded-for": "1.2.3.4" })
      const limited = await req(app, { "x-forwarded-for": "1.2.3.4" })
      expect(limited.status).toBe(429)

      const other = await req(app, { "x-forwarded-for": "5.6.7.8" })
      expect(other.status).toBe(200)
    })

    test("different identity keys have independent counters", async () => {
      const app = makeApp(2, ctx.store)
      await req(app, { "x-api-key": "keyA" })
      await req(app, { "x-api-key": "keyA" })
      expect((await req(app, { "x-api-key": "keyA" })).status).toBe(429)

      expect((await req(app, { "x-api-key": "keyB" })).status).toBe(200)
      expect((await req(app, { "x-api-key": "keyB" })).status).toBe(200)
      expect((await req(app, { "x-api-key": "keyB" })).status).toBe(429)
    })

    test("rpm=0 disables rate limiting entirely", async () => {
      const app = makeApp(0, ctx.store)
      for (let i = 0; i < 200; i++) {
        const res = await req(app, { "x-api-key": "k" })
        expect(res.status).toBe(200)
      }
    })

    test("no-auth no-proxy request falls back to 'unknown' IP bucket", async () => {
      const app = makeApp(2, ctx.store)
      await req(app)
      await req(app)
      const res = await req(app)
      expect(res.status).toBe(429)
    })

    test("no-auth no-proxy request uses internal socket IP header when available", async () => {
      const app = makeApp(2, ctx.store)
      await req(app, { [INTERNAL_CLIENT_IP_HEADER]: "10.0.0.1" })
      await req(app, { [INTERNAL_CLIENT_IP_HEADER]: "10.0.0.1" })
      expect((await req(app, { [INTERNAL_CLIENT_IP_HEADER]: "10.0.0.1" })).status).toBe(429)

      expect((await req(app, { [INTERNAL_CLIENT_IP_HEADER]: "10.0.0.2" })).status).toBe(200)
    })
  })
})
