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
    const readable = ["/System", "/Library", "/usr", "/bin", "/sbin", opts.workdir]
    const writable = [opts.workdir, ...(opts.writable ?? [])]
    const allowRead = readable.map((item) => `(allow file-read* (subpath \"${esc(item)}\"))`).join("\n")
    const allowWrite = writable.map((item) => `(allow file-write* (subpath \"${esc(item)}\"))`).join("\n")
    const allowNet = opts.network ? "(allow network*)" : "(deny network*)"

    return [
      "(version 1)",
      "(deny default)",
      "(allow process-exec)",
      "(allow process-fork)",
      allowRead,
      allowWrite,
      allowNet,
    ].join("\n")
  }

  export function spawn(opts: Sandbox.Options): ChildProcess {
    if (!available()) {
      throw new Error("macOS sandbox is unavailable: missing 'sandbox-exec' binary")
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-sbx-"))
    const file = path.join(dir, "policy.sb")
    fs.writeFileSync(file, profile(opts), "utf8")

    const proc = childSpawn("sandbox-exec", ["-f", file, "--", ...opts.command], {
      cwd: opts.workdir,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    })

    const cleanup = () => {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    proc.once("exit", cleanup)
    proc.once("error", cleanup)

    return proc
  }
}
