import { describe, expect, test, spyOn, afterEach } from "bun:test"
import { BwrapSandbox } from "../../src/sandbox/bwrap"

describe("BwrapSandbox", () => {
  afterEach(() => {
    // Reset any mocks
  })

  test("available() returns boolean based on bwrap binary presence", () => {
    const result = BwrapSandbox.available()
    expect(typeof result).toBe("boolean")
  })

  test("spawn() fails when bwrap unavailable", () => {
    if (BwrapSandbox.available()) {
      // Mock Bun.which to return null for this test
      const originalWhich = Bun.which
      Bun.which = () => null

      expect(() =>
        BwrapSandbox.spawn({
          command: ["echo", "test"],
          workdir: "/tmp",
        }),
      ).toThrow("Bubblewrap sandbox is unavailable: missing 'bwrap' binary")

      // Restore original
      Bun.which = originalWhich
    } else {
      // bwrap is actually unavailable
      expect(() =>
        BwrapSandbox.spawn({
          command: ["echo", "test"],
          workdir: "/tmp",
        }),
      ).toThrow("Bubblewrap sandbox is unavailable: missing 'bwrap' binary")
    }
  })

  test("spawn() constructs args with network blocked by default", async () => {
    if (!BwrapSandbox.available()) return // Skip if not available

    const { spawn } = await import("child_process")
    const mockSpawn = spyOn(await import("child_process"), "spawn").mockImplementation(
      () =>
        ({
          stdout: { on: () => {} },
          stderr: { on: () => {} },
          on: () => {},
          once: () => {},
          pid: 12345,
        }) as any,
    )

    try {
      BwrapSandbox.spawn({
        command: ["echo", "test"],
        workdir: "/tmp",
        network: false,
      })

      expect(mockSpawn).toHaveBeenCalledWith("bwrap", expect.arrayContaining(["--unshare-net"]), expect.any(Object))

      const args = mockSpawn.mock.calls[0][1]
      expect(args).not.toContain("--share-net")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("spawn() enables network only when explicitly requested", async () => {
    if (!BwrapSandbox.available()) return // Skip if not available

    const mockSpawn = spyOn(await import("child_process"), "spawn").mockImplementation(
      () =>
        ({
          stdout: { on: () => {} },
          stderr: { on: () => {} },
          on: () => {},
          once: () => {},
          pid: 12345,
        }) as any,
    )

    try {
      BwrapSandbox.spawn({
        command: ["echo", "test"],
        workdir: "/tmp",
        network: true,
      })

      expect(mockSpawn).toHaveBeenCalledWith("bwrap", expect.arrayContaining(["--share-net"]), expect.any(Object))

      const args = mockSpawn.mock.calls[0][1]
      expect(args).toContain("--share-net")
      expect(args).toContain("/etc/resolv.conf")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("spawn() includes writable paths", async () => {
    if (!BwrapSandbox.available()) return // Skip if not available

    const mockSpawn = spyOn(await import("child_process"), "spawn").mockImplementation(
      () =>
        ({
          stdout: { on: () => {} },
          stderr: { on: () => {} },
          on: () => {},
          once: () => {},
          pid: 12345,
        }) as any,
    )

    try {
      BwrapSandbox.spawn({
        command: ["echo", "test"],
        workdir: "/tmp",
        writable: ["/var/log", "/home/user"],
      })

      const args = mockSpawn.mock.calls[0][1]
      expect(args).toContain("--bind")
      expect(args).toContain("/var/log")
      expect(args).toContain("/home/user")
    } finally {
      mockSpawn.mockRestore()
    }
  })
})
