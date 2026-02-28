import { spawn as childSpawn, type ChildProcess } from "child_process"
import { Sandbox } from "./index"

export namespace BwrapSandbox {
  export function available() {
    return !!Bun.which("bwrap")
  }

  export function spawn(opts: Sandbox.Options): ChildProcess {
    if (!available()) {
      throw new Error("Bubblewrap sandbox is unavailable: missing 'bwrap' binary")
    }

    const args = [
      "--unshare-all",
      "--die-with-parent",
      "--new-session",
      "--no-new-privs",
      "--unshare-user",
      "--unshare-pid",
      "--unshare-uts",
      "--unshare-cgroup",
    ]

    // Network: default blocked unless explicitly enabled
    if (opts.network) {
      args.push("--share-net")
      args.push("--ro-bind", "/etc/resolv.conf", "/etc/resolv.conf")
    } else {
      args.push("--unshare-net")
    }

    // Minimal readonly filesystem
    args.push(
      "--ro-bind",
      "/usr",
      "/usr",
      "--ro-bind",
      "/lib",
      "/lib",
      "--ro-bind",
      "/lib64",
      "/lib64",
      "--ro-bind",
      "/bin",
      "/bin",
      "--ro-bind",
      "/sbin",
      "/sbin",
    )

    // Writable workspace
    args.push("--bind", opts.workdir, opts.workdir, "--chdir", opts.workdir)

    // Additional writable paths
    if (opts.writable) {
      for (const path of opts.writable) {
        args.push("--bind", path, path)
      }
    }

    // Command to execute
    args.push(...opts.command)

    return childSpawn("bwrap", args, {
      cwd: opts.workdir,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    })
  }
}
