import { describe, expect, test } from "bun:test"
import { mapA2AAuthzStatus } from "../../src/server/authz-status"

describe("a2a authz status mapping", () => {
  test("returns 401 for unauthenticated caller", () => {
    expect(mapA2AAuthzStatus(undefined, false)).toBe(401)
    expect(mapA2AAuthzStatus(403, false)).toBe(401)
  })

  test("returns 403 for authenticated deny", () => {
    expect(mapA2AAuthzStatus(undefined, true)).toBe(403)
    expect(mapA2AAuthzStatus(403, true)).toBe(403)
  })

  test("preserves configured 5xx status for authenticated authz errors", () => {
    expect(mapA2AAuthzStatus(503, true)).toBe(503)
  })

  test("normalizes authenticated 401 deny to 403", () => {
    expect(mapA2AAuthzStatus(401, true)).toBe(403)
  })
})
