import { spawn as childSpawn, type ChildProcess } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { Sandbox } from "./index"

function esc(input: string) {
  return input.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
}

export namespace DarwinSandbox {
  export function available() {
    return !!Bun.which("sandbox-exec")
  }

  function profile(opts: Sandbox.Options) {
    const writable = [opts.workdir, ...(opts.writable ?? [])]
    const allowWrite = writable.map((item) => `(allow file-write* (subpath \"${esc(item)}\"))`).join("\n")
    const allowNet = opts.network !== false ? "(allow network*)" : "(deny network*)"

    return [
      "(version 1)",
      "(deny default)",
      "(allow process-exec)",
      "(allow process-fork)",
      "(allow file-read*)",
      allowWrite,
      allowNet,
    ].join("\n")
  }

  export function spawn(opts: Sandbox.Options): ChildProcess {
    if (!available()) {
      throw new Error("macOS sandbox is unavailable: missing 'sandbox-exec' binary")
    }

    const profileString = profile(opts)

    return childSpawn("sandbox-exec", ["-p", profileString, "--", ...opts.command], {
      cwd: opts.workdir,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    })
  }
}
