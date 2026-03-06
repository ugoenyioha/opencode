import { describe, expect, test, spyOn } from "bun:test"
import os from "os"
import { GvisorSandbox } from "../../src/sandbox/gvisor"

describe("GvisorSandbox", () => {
  test("unavailable when platform not linux", () => {
    const platformSpy = spyOn(os, "platform").mockReturnValue("darwin")

    try {
      expect(GvisorSandbox.available()).toBe(false)
      expect(() =>
        GvisorSandbox.spawn({
          command: ["echo", "test"],
          workdir: "/tmp",
        }),
      ).toThrow("gVisor sandbox is unavailable")
    } finally {
      platformSpy.mockRestore()
    }
  })

  test("spawn constructs args with network and writable controls", async () => {
    const platformSpy = spyOn(os, "platform").mockReturnValue("linux")
    process.env.OPENCODE_GVISOR_RUNSC = "/tmp/fake-runsc"

    const child = await import("child_process")
    const spawnSpy = spyOn(child, "spawn").mockImplementation(() => {
      return {
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: () => {},
        once: () => {},
        pid: 1,
      } as any
    })

    try {
      GvisorSandbox.spawn({
        command: ["bash", "-lc", "echo hi"],
        workdir: "/workspace",
        network: true,
        writable: ["/tmp/data"],
        env: { FOO: "bar" },
      })

      expect(spawnSpy).toHaveBeenCalled()
      const args = spawnSpy.mock.calls[0][1]
      expect(args).toContain("--network=host")
      expect(args).toContain("--volume")
      expect(args).toContain("/workspace:/workspace")
      expect(args).toContain("/tmp/data:/tmp/data")
      const commandIndex = args.indexOf("--")
      expect(commandIndex).toBeGreaterThan(-1)
      expect(args.slice(commandIndex + 1)).toEqual(["bash", "-lc", "echo hi"])
    } finally {
      platformSpy.mockRestore()
      spawnSpy.mockRestore()
      delete process.env.OPENCODE_GVISOR_RUNSC
    }
  })
})
