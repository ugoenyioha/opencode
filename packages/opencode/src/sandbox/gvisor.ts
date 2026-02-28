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
    const args = ["do", "--cwd", opts.workdir]
    args.push(opts.network ? "--network=host" : "--network=none")

    const writable = new Set([opts.workdir, ...(opts.writable ?? [])])
    for (const dir of writable) {
      args.push("--volumes", `${dir}:${dir}`)
    }

    for (const [key, value] of Object.entries(opts.env ?? {})) {
      args.push("--env", `${key}=${value}`)
    }

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
