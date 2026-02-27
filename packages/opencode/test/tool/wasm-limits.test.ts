import { describe, expect, mock, test } from "bun:test"

const close = mock(() => {})

mock.module("@extism/extism", () => ({
  default: async () => ({
    call: () => new Promise(() => {}),
    close,
  }),
}))

const { WasmSandbox } = await import("../../src/sandbox/wasm")

describe("wasm sandbox limits", () => {
  test("times out long-running wasm execution", async () => {
    await expect(
      WasmSandbox.call(
        {
          wasm_path: "/tmp/never-used.wasm",
          timeout_ms: 25,
          network: false,
        },
        "execute",
        "{}",
      ),
    ).rejects.toThrow("Operation timed out after 25ms")
    expect(close).toHaveBeenCalledTimes(1)
  })
})
