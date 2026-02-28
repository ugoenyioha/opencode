import { spawn as childSpawn, type ChildProcess } from "child_process"
import fs from "fs"
import { Sandbox } from "./index"
import os from "os"

function binPath() {
  return process.env.OPENCODE_FIRECRACKER_BIN || Bun.which("firecracker") || undefined
}

function runnerPath() {
  return process.env.OPENCODE_FIRECRACKER_RUNNER
}

function kernelPath() {
  return process.env.OPENCODE_FIRECRACKER_KERNEL
}

function rootfsPath() {
  return process.env.OPENCODE_FIRECRACKER_ROOTFS
}

function requirements() {
  const bin = binPath()
  const runner = runnerPath()
  const kernel = kernelPath()
  const rootfs = rootfsPath()
  const missing: string[] = []
  if (os.platform() !== "linux") missing.push("linux platform")
  if (!bin || !fs.existsSync(bin)) missing.push("firecracker binary (OPENCODE_FIRECRACKER_BIN or PATH)")
  if (!runner || !fs.existsSync(runner)) missing.push("runner (OPENCODE_FIRECRACKER_RUNNER)")
  if (!kernel || !fs.existsSync(kernel)) missing.push("kernel image (OPENCODE_FIRECRACKER_KERNEL)")
  if (!rootfs || !fs.existsSync(rootfs)) missing.push("rootfs image (OPENCODE_FIRECRACKER_ROOTFS)")
  return {
    missing,
    bin,
    runner,
    kernel,
    rootfs,
  }
}

export namespace FirecrackerSandbox {
  export function available() {
    return requirements().missing.length === 0
  }

  export function unavailableMessage() {
    const check = requirements()
    return `Firecracker sandbox is unavailable: missing ${check.missing.join(", ")}. Set OPENCODE_FIRECRACKER_RUNNER, OPENCODE_FIRECRACKER_KERNEL, OPENCODE_FIRECRACKER_ROOTFS, and optional OPENCODE_FIRECRACKER_BIN.`
  }

  export function spawn(opts: Sandbox.Options): ChildProcess {
    const check = requirements()
    if (check.missing.length > 0) {
      throw new Error(unavailableMessage())
    }
    const args = [
      "--firecracker-bin",
      check.bin!,
      "--kernel",
      check.kernel!,
      "--rootfs",
      check.rootfs!,
      "--workdir",
      opts.workdir,
      "--network",
      opts.network ? "enabled" : "disabled",
    ]
    for (const dir of opts.writable ?? []) {
      args.push("--writable", dir)
    }
    for (const [key, value] of Object.entries(opts.env ?? {})) {
      args.push("--env", `${key}=${value}`)
    }
    args.push("--", ...opts.command)
    return childSpawn(check.runner!, args, {
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
