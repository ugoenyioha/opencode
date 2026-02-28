import type { ChildProcess } from "child_process"
import { LinuxSandbox } from "./linux"
import { DarwinSandbox } from "./darwin"
import { BwrapSandbox } from "./bwrap"
import { GvisorSandbox } from "./gvisor"
import { FirecrackerSandbox } from "./firecracker"
import os from "os"

export namespace Sandbox {
  export type Options = {
    command: string[]
    workdir: string
    network?: boolean
    writable?: string[]
    memory?: number
    cpu?: number
    env?: Record<string, string>
  }

  export type Backend = "firecracker" | "gvisor" | "bwrap" | "namespace" | "sandbox-exec" | "none"

  export function available(): Backend {
    if (os.platform() === "linux") {
      if (FirecrackerSandbox.available()) return "firecracker"
      if (GvisorSandbox.available()) return "gvisor"
      if (BwrapSandbox.available()) return "bwrap"
      return LinuxSandbox.available() ? "namespace" : "none"
    }
    if (os.platform() === "darwin") {
      return DarwinSandbox.available() ? "sandbox-exec" : "none"
    }
    return "none"
  }

  export function spawnWith(mode: Exclude<Backend, "none">, opts: Options): ChildProcess {
    if (mode === "firecracker") return FirecrackerSandbox.spawn(opts)
    if (mode === "gvisor") return GvisorSandbox.spawn(opts)
    if (mode === "bwrap") return BwrapSandbox.spawn(opts)
    if (mode === "namespace") return LinuxSandbox.spawn(opts)
    if (mode === "sandbox-exec") return DarwinSandbox.spawn(opts)
    throw new Error(`Sandbox backend '${mode}' is not supported on platform: ${os.platform()}`)
  }

  export function spawn(opts: Options): ChildProcess {
    const mode = Sandbox.available()
    if (mode === "none") {
      throw new Error(`Sandbox not supported on platform: ${os.platform()}`)
    }
    return spawnWith(mode, opts)
  }
}
