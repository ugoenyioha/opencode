import { describe, expect, test } from "bun:test"
import { SessionLoop } from "../../src/session/loop"

describe("session loop parser", () => {
  test("parses create and stop commands", async () => {
    const stop = SessionLoop.parse("/loop stop")
    expect(stop).toEqual({ type: "stop" })

    const create = SessionLoop.parse("/loop 5 check status")
    expect(create).toBeDefined()
    expect(create?.type).toBe("create")
    if (!create || create.type !== "create") throw new Error("expected create")
    expect(create.minutes).toBe(5)
    expect(create.interval_ms).toBe(300000)
    expect(create.prompt).toBe("check status")
  })

  test("rejects invalid inputs", async () => {
    const bad1 = SessionLoop.parse("/loop")
    expect(bad1).toBeUndefined()

    const bad2 = SessionLoop.parse("/loop 0.5 soon")
    expect(bad2?.type).toBe("invalid")

    const bad3 = SessionLoop.parse("/loop x hello")
    expect(bad3?.type).toBe("invalid")
  })
})
