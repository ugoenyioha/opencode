import { describe, expect, test } from "bun:test"
import { FirecrackerSandbox } from "../../src/sandbox/firecracker"
import { Sandbox } from "../../src/sandbox"

describe("FirecrackerSandbox", () => {
  test("available returns false on non-linux", () => {
    if (process.platform === "linux") return
    expect(FirecrackerSandbox.available()).toBe(false)
  })

  test("available returns false without required assets", () => {
    if (process.platform !== "linux") return
    const previousKernel = process.env.OPENCODE_FIRECRACKER_KERNEL
    const previousRootfs = process.env.OPENCODE_FIRECRACKER_ROOTFS
    const previousRunner = process.env.OPENCODE_FIRECRACKER_RUNNER
    const previousBin = process.env.OPENCODE_FIRECRACKER_BIN
    delete process.env.OPENCODE_FIRECRACKER_KERNEL
    delete process.env.OPENCODE_FIRECRACKER_ROOTFS
    delete process.env.OPENCODE_FIRECRACKER_RUNNER
    delete process.env.OPENCODE_FIRECRACKER_BIN
    try {
      expect(FirecrackerSandbox.available()).toBe(false)
    } finally {
      process.env.OPENCODE_FIRECRACKER_KERNEL = previousKernel
      process.env.OPENCODE_FIRECRACKER_ROOTFS = previousRootfs
      process.env.OPENCODE_FIRECRACKER_RUNNER = previousRunner
      process.env.OPENCODE_FIRECRACKER_BIN = previousBin
    }
  })

  test("spawn throws actionable error when unavailable", () => {
    if (process.platform !== "linux") return
    const previousKernel = process.env.OPENCODE_FIRECRACKER_KERNEL
    const previousRootfs = process.env.OPENCODE_FIRECRACKER_ROOTFS
    const previousRunner = process.env.OPENCODE_FIRECRACKER_RUNNER
    const previousBin = process.env.OPENCODE_FIRECRACKER_BIN
    delete process.env.OPENCODE_FIRECRACKER_KERNEL
    delete process.env.OPENCODE_FIRECRACKER_ROOTFS
    delete process.env.OPENCODE_FIRECRACKER_RUNNER
    delete process.env.OPENCODE_FIRECRACKER_BIN
    try {
      expect(() =>
        FirecrackerSandbox.spawn({
          command: ["echo", "test"],
          workdir: "/tmp",
        }),
      ).toThrow("Firecracker sandbox is unavailable")
    } finally {
      process.env.OPENCODE_FIRECRACKER_KERNEL = previousKernel
      process.env.OPENCODE_FIRECRACKER_ROOTFS = previousRootfs
      process.env.OPENCODE_FIRECRACKER_RUNNER = previousRunner
      process.env.OPENCODE_FIRECRACKER_BIN = previousBin
    }
  })

  test("auto path can select firecracker only when available", () => {
    if (process.platform !== "linux") return
    const available = Sandbox.available()
    if (available !== "firecracker") {
      expect(["gvisor", "bwrap", "namespace", "none"]).toContain(available)
      return
    }
    expect(available).toBe("firecracker")
  })
})
