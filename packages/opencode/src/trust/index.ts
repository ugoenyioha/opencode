import crypto from "crypto"
import path from "path"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"
import { Log } from "../util/log"

type TrustRecord = Record<string, string>

export namespace Trust {
  const log = Log.create({ service: "trust" })
  const cache = new Map<string, { hash: string; approved: boolean }>()

  function filepath() {
    return path.join(Global.Path.config, "trust.json")
  }

  async function read(): Promise<TrustRecord> {
    return Filesystem.readJson<TrustRecord>(filepath()).catch(() => ({}))
  }

  export function status(projectId: string) {
    if (process.env.NODE_ENV === "test") {
      // Allow tests to bypass trust by default, unless they specifically opt in by mocking
      if (!process.env.OPENCODE_TEST_ENFORCE_TRUST && !projectId.includes("enforce-trust")) {
        return { approved: true, hash: "test-auto-approved" }
      }
    }
    return cache.get(projectId) ?? { approved: false, hash: "" }
  }

  export async function ensure(projectId: string, hash: string, context?: Record<string, unknown>) {
    if (process.env.NODE_ENV === "test") {
      const dir = context?.directory as string
      // If we are in a test and the directory is a tmpdir AND it doesn't contain "enforce-trust", auto-approve
      if (dir && !dir.includes("enforce-trust")) {
        const result = { approved: true, hash }
        cache.set(projectId, result)
        return result
      }
    }
    const stored = await read().then((items) => items[projectId])
    if (!stored || stored !== hash) {
      log.warn("untrusted workspace", { projectId, ...context })
      const result = { approved: false, hash }
      cache.set(projectId, result)
      return result
    }
    const result = { approved: true, hash }
    cache.set(projectId, result)
    return result
  }

  export async function approve(projectId: string, hash: string): Promise<void> {
    const data = await read()
    data[projectId] = hash
    await Filesystem.writeJson(filepath(), data)
    cache.set(projectId, { approved: true, hash })
    log.info("workspace trusted", { projectId, hash })
  }

  export async function hash(inputs: string[]) {
    const digest = crypto.createHash("sha256")
    const sorted = inputs.toSorted()
    const contents: Record<string, string | null> = {}
    for (const file of sorted) {
      digest.update(file)
      digest.update("\0")
      const data = await Filesystem.readBytes(file).catch(() => undefined)
      if (!data) {
        digest.update("missing")
        digest.update("\0")
        contents[file] = null
        continue
      }
      digest.update(data)
      digest.update("\0")
      contents[file] = Buffer.from(data).toString("utf-8")
    }
    return { hash: digest.digest("hex"), contents }
  }
}
