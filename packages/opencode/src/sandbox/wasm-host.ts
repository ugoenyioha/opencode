import type { CallContext, ExtismPluginOptions } from "@extism/extism"
import fs from "fs"
import path from "path"
import { Log } from "../util/log"

const log = Log.create({ service: "wasm-tool" })

export type Options = {
  network: boolean
  allowed_hosts?: string[]
  allowed_paths?: string[]
}

function text(ctx: CallContext, addr: bigint) {
  const out = ctx.read(addr)
  if (!out) return
  return out.text()
}

function allowed(paths: string[] | undefined, file: string) {
  if (!paths || !paths.length) return true
  return paths.some((p) => {
    try {
      const allowedPath = path.resolve(p)
      const allowedReal = fs.existsSync(allowedPath) ? fs.realpathSync(allowedPath) : allowedPath
      // Add a trailing slash to ensure we don't match partial directory names (e.g. /foo/bar and /foo/bar-baz)
      const prefix = allowedReal.endsWith(path.sep) ? allowedReal : allowedReal + path.sep
      return file === allowedReal || file.startsWith(prefix)
    } catch {
      return false
    }
  })
}

export function hostFunctions(opts: Options): NonNullable<ExtismPluginOptions["functions"]> {
  return {
    "opencode:sandbox": {
      read_file(ctx: CallContext, path_ptr: bigint) {
        const file = text(ctx, path_ptr)
        if (!file) {
          ctx.setError("missing read_file path")
          return 0n
        }

        let realPath: string
        try {
          const resolvedPath = path.resolve(file)
          realPath = fs.existsSync(resolvedPath) ? fs.realpathSync(resolvedPath) : resolvedPath
        } catch {
          ctx.setError("access denied: invalid path")
          return 0n
        }

        if (!allowed(opts.allowed_paths, realPath)) {
          ctx.setError("access denied: path outside allowed directories")
          return 0n
        }

        if (!fs.existsSync(realPath)) {
          ctx.setError("read_file path does not exist")
          return 0n
        }

        try {
          return ctx.store(fs.readFileSync(realPath))
        } catch (e: any) {
          ctx.setError("access denied: failed to read file")
          return 0n
        }
      },
      log(ctx: CallContext, level_ptr: bigint, msg_ptr: bigint) {
        const level = text(ctx, level_ptr) ?? "info"
        const msg = text(ctx, msg_ptr) ?? ""
        const cleanMsg = msg.replace(/\r?\n|\r/g, " ") // prevent log forging

        if (level === "error") {
          log.error(cleanMsg)
          return
        }
        if (level === "warn") {
          log.warn(cleanMsg)
          return
        }
        if (level === "debug") {
          log.debug(cleanMsg)
          return
        }
        log.info(cleanMsg)
      },
      fetch(ctx: CallContext, url_ptr: bigint) {
        if (!opts.network) {
          ctx.setError("access denied: network is disabled")
          return 0n
        }

        const url_str = text(ctx, url_ptr)
        if (!url_str) {
          ctx.setError("missing fetch url")
          return 0n
        }

        let parsed: URL
        try {
          parsed = new URL(url_str)
        } catch {
          ctx.setError("access denied: invalid url")
          return 0n
        }

        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          ctx.setError("access denied: only http/https schemas are allowed")
          return 0n
        }

        if (opts.allowed_hosts && opts.allowed_hosts.length > 0) {
          const host = parsed.hostname
          const isAllowed = opts.allowed_hosts.some((h) => host === h || host.endsWith(`.${h}`))
          if (!isAllowed) {
            ctx.setError("access denied: host not in allowed_hosts")
            return 0n
          }
        }

        ctx.setError("fetch host function is not implemented yet")
        return ctx.store("")
      },
    },
  }
}
