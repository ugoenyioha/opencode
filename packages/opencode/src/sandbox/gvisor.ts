import { spawn as childSpawn, type ChildProcess } from "child_process"
import { Sandbox } from "./index"
import os from "os"

function runscPath() {
  if (process.env.OPENCODE_GVISOR_RUNSC) return process.env.OPENCODE_GVISOR_RUNSC
  return Bun.which("runsc") ?? undefined
}

export namespace GvisorSandbox {
  export function available() {
    return os.platform() === "linux" && !!runscPath()
  }

  export function spawn(opts: Sandbox.Options): ChildProcess {
    if (!available()) {
      throw new Error("gVisor sandbox is unavailable: missing 'runsc' binary or unsupported platform")
    }

    const runsc = runscPath()!
    const args: string[] = ["--rootless"]
    args.push(opts.network ? "--network=host" : "--network=none")
    args.push("do", "--cwd", opts.workdir)

    const writable = new Set([opts.workdir, ...(opts.writable ?? [])])
    for (const dir of writable) {
      args.push("--volume", `${dir}:${dir}`)
    }

    // Environment is passed natively to the childSpawn process, runsc do inherits it
    // No need to pass --env flags

    args.push("--", ...opts.command)

    return childSpawn(runsc, args, {
      cwd: opts.workdir,
      env: {
        ...process.env,
        ...opts.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    })
  }
}
