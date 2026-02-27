import { spawn as childSpawn, type ChildProcess } from "child_process"
import { Sandbox } from "./index"

export namespace LinuxSandbox {
  export function available() {
    return !!Bun.which("unshare")
  }

  export function spawn(opts: Sandbox.Options): ChildProcess {
    if (!available()) {
      throw new Error("Linux namespace sandbox is unavailable: missing 'unshare' binary")
    }

    const args = ["--mount", "--pid", "--fork", "--user", "--map-root-user", "--propagation", "private"]
    if (!opts.network) args.push("--net")
    args.push(...opts.command)

    return childSpawn("unshare", args, {
      cwd: opts.workdir,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    })
  }
}
