import { describe, expect, test } from "bun:test"
import { Binary } from "@opencode-ai/util/binary"

describe("util.binary.search", () => {
  test("finds item in sorted array", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }]
    const result = Binary.search(items, "b", (x) => x.id)
    expect(result).toStrictEqual({ found: true, index: 1 })
  })

  test("returns insertion index when not found", () => {
    const items = [{ id: "a" }, { id: "c" }, { id: "e" }]
    const result = Binary.search(items, "d", (x) => x.id)
    expect(result).toStrictEqual({ found: false, index: 2 })
  })

  test("handles empty array", () => {
    const result = Binary.search([], "a", (x: { id: string }) => x.id)
    expect(result).toStrictEqual({ found: false, index: 0 })
  })

  test("handles single item found", () => {
    const result = Binary.search([{ id: "x" }], "x", (x) => x.id)
    expect(result).toStrictEqual({ found: true, index: 0 })
  })

  test("handles single item not found", () => {
    const result = Binary.search([{ id: "b" }], "a", (x) => x.id)
    expect(result).toStrictEqual({ found: false, index: 0 })
  })

  test("uses localeCompare ordering for mixed-case base62 IDs", () => {
    // localeCompare treats uppercase differently than byte comparison (<)
    // "Z" < "a" in byte comparison but localeCompare may differ
    const ids = ["Ab1", "Zx9", "aB2", "zZ0"].toSorted((a, b) => a.localeCompare(b))
    const items = ids.map((id) => ({ id }))

    for (let i = 0; i < items.length; i++) {
      const result = Binary.search(items, items[i].id, (x) => x.id)
      expect(result.found).toBe(true)
      expect(result.index).toBe(i)
    }
  })

  test("consistent with localeCompare sorted arrays", () => {
    const raw = ["session_Zk3mQ", "session_aB7xR", "session_Ab2nP", "session_zz9wL", "session_09abc"]
    const sorted = [...raw].sort((a, b) => a.localeCompare(b))
    const items = sorted.map((id) => ({ id }))

    for (const id of raw) {
      const result = Binary.search(items, id, (x) => x.id)
      expect(result.found).toBe(true)
      expect(items[result.index].id).toBe(id)
    }
  })

  test("not found returns correct insertion point for localeCompare order", () => {
    const sorted = ["alpha", "bravo", "delta"].sort((a, b) => a.localeCompare(b))
    const items = sorted.map((id) => ({ id }))
    const result = Binary.search(items, "charlie", (x) => x.id)
    expect(result.found).toBe(false)
    // charlie should go between bravo and delta
    expect(result.index).toBe(2)
  })
})

describe("util.binary.insert", () => {
  test("inserts into empty array", () => {
    const items: { id: string }[] = []
    Binary.insert(items, { id: "a" }, (x) => x.id)
    expect(items).toStrictEqual([{ id: "a" }])
  })

  test("inserts at beginning", () => {
    const items = [{ id: "b" }, { id: "c" }]
    Binary.insert(items, { id: "a" }, (x) => x.id)
    expect(items.map((x) => x.id)).toStrictEqual(["a", "b", "c"])
  })

  test("inserts at end", () => {
    const items = [{ id: "a" }, { id: "b" }]
    Binary.insert(items, { id: "c" }, (x) => x.id)
    expect(items.map((x) => x.id)).toStrictEqual(["a", "b", "c"])
  })

  test("inserts in middle", () => {
    const items = [{ id: "a" }, { id: "c" }]
    Binary.insert(items, { id: "b" }, (x) => x.id)
    expect(items.map((x) => x.id)).toStrictEqual(["a", "b", "c"])
  })

  test("maintains localeCompare sort order with mixed-case IDs", () => {
    const items: { id: string }[] = []
    const ids = ["Zx9", "aB2", "Ab1", "zZ0", "09a"]
    for (const id of ids) {
      Binary.insert(items, { id }, (x) => x.id)
    }
    const expected = [...ids].sort((a, b) => a.localeCompare(b))
    expect(items.map((x) => x.id)).toStrictEqual(expected)
  })

  test("search finds items after insert", () => {
    const items: { id: string }[] = []
    const ids = ["delta", "alpha", "charlie", "bravo"]
    for (const id of ids) {
      Binary.insert(items, { id }, (x) => x.id)
    }
    for (const id of ids) {
      const result = Binary.search(items, id, (x) => x.id)
      expect(result.found).toBe(true)
      expect(items[result.index].id).toBe(id)
    }
  })
})
