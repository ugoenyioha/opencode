import type { ChildProcess } from "child_process"
import { LinuxSandbox } from "./linux"
import { DarwinSandbox } from "./darwin"
import { BwrapSandbox } from "./bwrap"
import { GvisorSandbox } from "./gvisor"
import { FirecrackerSandbox } from "./firecracker"
import { Config } from "../config/config"
import { Agent } from "../agent/agent"
import type z from "zod"
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

  export type Backend = "firecracker" | "gvisor" | "bwrap" | "namespace" | "sandbox-exec" | "none" | "auto"

  const BACKEND_RESTRICTIVENESS: Record<Backend, number> = {
    none: 0,
    "sandbox-exec": 1,
    namespace: 1,
    bwrap: 2,
    gvisor: 3,
    firecracker: 4,
    // auto has highest restrictiveness (5) because it represents "most restrictive available"
    // This ensures that if global config uses "auto" and agent tries to downgrade to a specific
    // backend, the "auto" setting wins and continues to use the most restrictive available option
    auto: 5,
  }

  /**
   * Computes the effective sandbox configuration by merging global defaults
   * with agent-specific overrides, ensuring agents can only make the sandbox
   * MORE restrictive, never less.
   */
  export async function getEffectiveConfig(agentName?: string): Promise<z.infer<typeof Config.Sandbox>> {
    const config = await Config.get()
    const globalSandbox = config.sandbox ?? {}

    if (!agentName) {
      return globalSandbox
    }

    try {
      const agent = await Agent.get(agentName)
      if (agent?.sandbox) {
        const agentSandbox = agent.sandbox

        // Compute effective network: false is more restrictive than true.
        // If global is false, agent cannot make it true.
        const effectiveNetwork = (globalSandbox.network ?? false) && (agentSandbox.network ?? false)

        // Compute effective bash backend: pick the more restrictive one
        const globalBash: Backend = globalSandbox.bash ?? "none"
        const agentBash: Backend = agentSandbox.bash ?? "none"
        const effectiveBash: Backend =
          BACKEND_RESTRICTIVENESS[agentBash] > BACKEND_RESTRICTIVENESS[globalBash] ? agentBash : globalBash

        // For memory and cpu, lower is more restrictive
        // Validate that values are finite numbers to prevent bypass via Infinity
        const globalMemory = globalSandbox.memory_mb
        const agentMemory = agentSandbox.memory_mb
        const globalCpu = globalSandbox.cpu_percent
        const agentCpu = agentSandbox.cpu_percent

        const effectiveMemory =
          globalMemory !== undefined && agentMemory !== undefined
            ? Math.min(globalMemory, agentMemory)
            : (globalMemory ?? agentMemory)
        const effectiveCpu =
          globalCpu !== undefined && agentCpu !== undefined ? Math.min(globalCpu, agentCpu) : (globalCpu ?? agentCpu)

        // Validate finite values
        if (effectiveMemory !== undefined && !Number.isFinite(effectiveMemory)) {
          throw new Error("Sandbox memory_mb must be a finite number")
        }
        if (effectiveCpu !== undefined && !Number.isFinite(effectiveCpu)) {
          throw new Error("Sandbox cpu_percent must be a finite number")
        }

        return {
          ...globalSandbox,
          ...agentSandbox,
          network: effectiveNetwork,
          bash: effectiveBash,
          memory_mb: effectiveMemory,
          cpu_percent: effectiveCpu,
        }
      }
    } catch {
      // Agent not found or failed to load, fall back to global
    }

    return globalSandbox
  }

  export function available(): Exclude<Backend, "auto"> {
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
