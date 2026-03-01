import createPlugin from "@extism/extism"
import { withTimeout } from "@/util/timeout"
import { hostFunctions, type Options as HostOptions } from "./wasm-host"

export namespace WasmSandbox {
  export type Options = HostOptions & {
    wasm_path: string
    timeout_ms?: number
    memory_pages?: number
    enable_wasi?: boolean
  }

  function paths(paths: string[] | undefined) {
    if (!paths || !paths.length) return
    return paths.reduce(
      (result, path) => {
        result[path] = path
        return result
      },
      {} as Record<string, string>,
    )
  }

  export async function call(opts: Options, func: string, input: string) {
    const timeout = opts.timeout_ms ?? 30000
    const pages = opts.memory_pages ?? 256
    const plugin = await createPlugin(opts.wasm_path, {
      useWasi: opts.enable_wasi ?? true,
      // Extism requires runInWorker: true to use timeoutMs. However, Bun currently panics
      // if you try to use WASI inside a Worker thread.
      // Until Bun fixes WASI in workers, we must omit timeoutMs here and rely purely
      // on the Promise.race withTimeout wrapper below.
      // timeoutMs: timeout,
      memory: {
        maxPages: pages,
      },
      allowedHosts: opts.network ? opts.allowed_hosts : [],
      allowedPaths: paths(opts.allowed_paths),
      functions: hostFunctions(opts),
    })

    return withTimeout(plugin.call(func, input), timeout)
      .then((out) => out?.text() ?? "")
      .finally(() => plugin.close())
  }
}
