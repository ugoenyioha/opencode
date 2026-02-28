import { describe, test, expect } from "bun:test"
import path from "path"
import type { RateLimitStore } from "../../src/server/rate-limit/store"
import { MemoryRateLimitStore, SqliteRateLimitStore } from "../../src/server/rate-limit/store"
import { tmpdir } from "../fixture/fixture"

type Factory = () => Promise<{ store: RateLimitStore; cleanup: () => Promise<void> }>

async function withStore(factory: Factory, fn: (store: RateLimitStore) => Promise<void>) {
  const ctx = await factory()
  try {
    await fn(ctx.store)
  } finally {
    await ctx.cleanup()
  }
}

const memoryFactory: Factory = async () => {
  const store = new MemoryRateLimitStore()
  return {
    store,
    cleanup: async () => {
      store.reset()
    },
  }
}

const sqliteFactory: Factory = async () => {
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
}

const suites: [string, Factory][] = [
  ["memory", memoryFactory],
  ["sqlite", sqliteFactory],
]

suites.forEach(([name, factory]) => {
  describe(`${name} store`, () => {
    test("allows up to the limit then blocks", async () => {
      await withStore(factory, async (store) => {
        expect(await store.increment("a", 1, 2)).toBe(true)
        expect(await store.increment("a", 1, 2)).toBe(true)
        expect(await store.increment("a", 1, 2)).toBe(false)
      })
    })

    test("starting a new window resets counters", async () => {
      await withStore(factory, async (store) => {
        expect(await store.increment("a", 5, 1)).toBe(true)
        expect(await store.increment("a", 5, 1)).toBe(false)
        expect(await store.increment("a", 6, 1)).toBe(true)
      })
    })

    test("different keys do not interfere", async () => {
      await withStore(factory, async (store) => {
        expect(await store.increment("first", 7, 1)).toBe(true)
        expect(await store.increment("first", 7, 1)).toBe(false)
        expect(await store.increment("second", 7, 1)).toBe(true)
      })
    })

    test("reset clears tracked counts", async () => {
      await withStore(factory, async (store) => {
        expect(await store.increment("a", 9, 1)).toBe(true)
        expect(await store.increment("a", 9, 1)).toBe(false)
        await store.reset()
        expect(await store.increment("a", 9, 1)).toBe(true)
      })
    })
  })
})

describe("sqlite store coordination", () => {
  test("shares counters across store instances", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "shared.db")
    const first = new SqliteRateLimitStore({ path: file })
    const second = new SqliteRateLimitStore({ path: file })
    expect(await first.increment("key", 1, 1)).toBe(true)
    expect(await second.increment("key", 1, 1)).toBe(false)
    first.close()
    second.close()
  })
})
