import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { hostFunctions } from "../../src/sandbox/wasm-host"

function context(input: string | undefined) {
  let error = ""
  const value = input
  const ctx = {
    read() {
      if (value === undefined) return
      return {
        text() {
          return value
        },
      }
    },
    setError(next: string) {
      error = next
    },
    store() {
      return 1n
    },
  }
  return {
    ctx: ctx as any,
    error() {
      return error
    },
  }
}

describe("wasm host security", () => {
  test("denies read_file path escape outside allowed paths", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "inside.txt"), "inside")
      },
    })
    await using outside = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "outside.txt"), "outside")
      },
    })
    const funcs = hostFunctions({
      network: false,
      allowed_paths: [tmp.path],
    })
    const call = context(path.join(outside.path, "outside.txt"))
    funcs["opencode:sandbox"].read_file(call.ctx, 1n)
    expect(call.error()).toBe("access denied: path outside allowed directories")
  })

  test("denies fetch when network is disabled", () => {
    const funcs = hostFunctions({
      network: false,
      allowed_hosts: ["example.com"],
    })
    const call = context("https://example.com")
    funcs["opencode:sandbox"].fetch(call.ctx, 1n)
    expect(call.error()).toBe("access denied: network is disabled")
  })
})
