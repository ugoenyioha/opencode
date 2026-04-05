/**
 * Tests for TeamMemory — shared knowledge store for agent teams.
 */
import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Env } from "../../src/env"
import { Log } from "../../src/util/log"
import { TeamMemory } from "../../src/team/memory"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

// ---------------------------------------------------------------------------
// 1. Write and read back
// ---------------------------------------------------------------------------
describe("TeamMemory.write / readAll", () => {
  test("written entry is readable via readAll", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        await TeamMemory.write("arch-decisions", "Use PostgreSQL for persistence.")
        const all = await TeamMemory.readAll()
        expect(all.has("arch-decisions")).toBe(true)
        expect(all.get("arch-decisions")).toContain("Use PostgreSQL")
      },
    })
  })

  test("multiple keys are all readable", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        await TeamMemory.write("db-schema", "Users table: id, email, created_at")
        await TeamMemory.write("api-endpoints", "POST /auth/login returns JWT")
        const all = await TeamMemory.readAll()
        expect(all.size).toBe(2)
        expect(all.has("db-schema")).toBe(true)
        expect(all.has("api-endpoints")).toBe(true)
      },
    })
  })

  test("writing same key appends content", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        await TeamMemory.write("notes", "First note.")
        await TeamMemory.write("notes", "Second note.")
        const all = await TeamMemory.readAll()
        const content = all.get("notes") ?? ""
        expect(content).toContain("First note.")
        expect(content).toContain("Second note.")
      },
    })
  })
})

// ---------------------------------------------------------------------------
// 2. Key sanitization
// ---------------------------------------------------------------------------
describe("TeamMemory — key sanitization", () => {
  test("keys with spaces and special chars are normalized", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        await TeamMemory.write("My Key!@#", "content")
        const all = await TeamMemory.readAll()
        // Key should be sanitized to "my-key---" or similar normalized form
        expect(all.size).toBe(1)
        const [key] = [...all.keys()]
        expect(key).toMatch(/^[a-z0-9-]+$/)
      },
    })
  })

  test("empty key after sanitization falls back to 'default'", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        await TeamMemory.write("!!!###", "content")
        const all = await TeamMemory.readAll()
        expect(all.has("default")).toBe(true)
      },
    })
  })
})

// ---------------------------------------------------------------------------
// 3. Secret scanner
// ---------------------------------------------------------------------------
describe("TeamMemory — secret scanner", () => {
  test("rejects content with AWS access key", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        await expect(
          TeamMemory.write("creds", "My key is AKIAIOSFODNN7EXAMPLE and it works")
        ).rejects.toThrow(/secret/)
      },
    })
  })

  test("rejects content with GitHub token", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        await expect(
          TeamMemory.write("token", "Use ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZabcdefghijklmnop123 for auth")
        ).rejects.toThrow(/secret/)
      },
    })
  })

  test("rejects private key content", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        await expect(
          TeamMemory.write("key", "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAK...")
        ).rejects.toThrow(/secret/)
      },
    })
  })

  test("accepts normal content without secrets", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        await expect(
          TeamMemory.write("safe", "The auth module is in src/auth/. It uses JWT.")
        ).resolves.toBeTruthy()
      },
    })
  })
})

// ---------------------------------------------------------------------------
// 4. Size limits
// ---------------------------------------------------------------------------
describe("TeamMemory — size limits", () => {
  test("rejects content exceeding FILE_SIZE_LIMIT", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        const huge = "x".repeat(9 * 1024) // 9KB > 8KB limit
        await expect(
          TeamMemory.write("big", huge)
        ).rejects.toThrow(/too large/)
      },
    })
  })
})

// ---------------------------------------------------------------------------
// 5. remove and clear
// ---------------------------------------------------------------------------
describe("TeamMemory.remove / clear", () => {
  test("remove deletes a specific key", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        await TeamMemory.write("to-delete", "goodbye")
        await TeamMemory.write("to-keep", "stay")
        await TeamMemory.remove("to-delete")
        const all = await TeamMemory.readAll()
        expect(all.has("to-delete")).toBe(false)
        expect(all.has("to-keep")).toBe(true)
      },
    })
  })

  test("clear removes all entries", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        await TeamMemory.write("a", "one")
        await TeamMemory.write("b", "two")
        await TeamMemory.clear()
        const all = await TeamMemory.readAll()
        expect(all.size).toBe(0)
      },
    })
  })
})

// ---------------------------------------------------------------------------
// 6. systemPromptFragment
// ---------------------------------------------------------------------------
describe("TeamMemory.systemPromptFragment", () => {
  test("returns empty string when no memory", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        const frag = await TeamMemory.systemPromptFragment()
        expect(frag).toBe("")
      },
    })
  })

  test("returns formatted prompt fragment when memory exists", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => { Env.set("ANTHROPIC_API_KEY", "test-key") },
      fn: async () => {
        await TeamMemory.write("db", "PostgreSQL is the primary DB.")
        const frag = await TeamMemory.systemPromptFragment()
        expect(frag).toContain("Team Memory")
        expect(frag).toContain("db")
        expect(frag).toContain("PostgreSQL")
      },
    })
  })
})
