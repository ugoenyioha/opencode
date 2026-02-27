import type { ChildProcess } from "child_process"
import { LinuxSandbox } from "./linux"
import { DarwinSandbox } from "./darwin"
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

  export function available(): "namespace" | "sandbox-exec" | "none" {
    if (os.platform() === "linux") {
      return LinuxSandbox.available() ? "namespace" : "none"
    }
    if (os.platform() === "darwin") {
      return DarwinSandbox.available() ? "sandbox-exec" : "none"
    }
    return "none"
  }

  export function spawn(opts: Options): ChildProcess {
    if (os.platform() === "linux") {
      return LinuxSandbox.spawn(opts)
    }
    if (os.platform() === "darwin") {
      return DarwinSandbox.spawn(opts)
    }
    throw new Error(`Sandbox not supported on platform: ${os.platform()}`)
  }
}
