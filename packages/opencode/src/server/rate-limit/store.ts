import { Database } from "bun:sqlite"
import type { Statement } from "bun:sqlite"
import { mkdirSync } from "fs"
import path from "path"
import { Global } from "../../global"

type MaybePromise<T> = T | Promise<T>

export interface RateLimitStore {
  increment(key: string, window: number, limit: number): MaybePromise<boolean>
  reset(): MaybePromise<void>
}

type Bucket = { count: number; window: number }

export class MemoryRateLimitStore implements RateLimitStore {
  #map = new Map<string, Bucket>()

  increment(key: string, window: number, limit: number) {
    const bucket = this.#map.get(key)
    if (!bucket || bucket.window !== window) {
      this.#map.set(key, { count: 1, window })
      return true
    }
    if (bucket.count >= limit) return false
    bucket.count++
    return true
  }

  reset() {
    this.#map.clear()
  }
}

export type SqliteRateLimitStoreOptions = {
  path?: string
}

export class SqliteRateLimitStore implements RateLimitStore {
  #db: Database
  #insert: Statement
  #update: Statement
  #cleanup: Statement
  #gcWindow = -1
  #tx: (key: string, window: number, limit: number) => boolean

  constructor(options?: SqliteRateLimitStoreOptions) {
    const filepath = options?.path ?? path.join(Global.Path.data, "rate-limit.db")
    mkdirSync(path.dirname(filepath), { recursive: true })

    this.#db = new Database(filepath, { create: true })
    this.#db.run("PRAGMA journal_mode = WAL")
    this.#db.run("PRAGMA synchronous = NORMAL")
    this.#db.run("PRAGMA busy_timeout = 5000")
    this.#db.run("PRAGMA cache_size = -64000")
    this.#db.exec(
      "CREATE TABLE IF NOT EXISTS rate_limit (key TEXT NOT NULL, window INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (key, window)) WITHOUT ROWID",
    )

    this.#insert = this.#db.prepare("INSERT OR IGNORE INTO rate_limit(key, window, count) VALUES (?, ?, 0)")
    this.#update = this.#db.prepare(
      "UPDATE rate_limit SET count = count + 1 WHERE key = ? AND window = ? AND count < ?",
    )
    this.#cleanup = this.#db.prepare("DELETE FROM rate_limit WHERE window < ?")

    this.#tx = this.#db.transaction((key: string, window: number, limit: number) => {
      this.#insert.run(key, window)
      const result = this.#update.run(key, window, limit)
      return result.changes === 1
    })
  }

  increment(key: string, window: number, limit: number) {
    const allowed = this.#tx(key, window, limit)
    if (window > this.#gcWindow) {
      this.#gcWindow = window
      this.#cleanup.run(window)
    }
    return allowed
  }

  reset() {
    this.#db.run("DELETE FROM rate_limit")
  }

  close() {
    this.#db.close()
  }
}
