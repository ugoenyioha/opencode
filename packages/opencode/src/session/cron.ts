import z from "zod"
import { Identifier } from "@/id/id"
import { SessionCronTable } from "./session.sql"
import { Database, eq, lte, sql } from "@/storage/db"
import { fn } from "@/util/fn"
import { SessionPrompt } from "./prompt"
import { Log } from "@/util/log"
import { Instance } from "@/project/instance"
import { SessionLoop } from "./loop"
import { SessionID } from "./schema"

export namespace SessionCron {
  const log = Log.create({ service: "session.cron" })
  const interval = 30_000
  const locks = new Map<string, Promise<void>>()

  type Timer = ReturnType<typeof setInterval>
  type State = {
    timer?: Timer
    busy: boolean
  }

  const state = Instance.state(
    (): State => ({
      busy: false,
    }),
    async (item) => {
      if (!item.timer) return
      clearInterval(item.timer)
    },
  )

  export const CreateInput = z.object({
    sessionID: SessionID.zod,
    interval_ms: z.number().int().min(SessionLoop.MIN_INTERVAL_MS),
    prompt: z.string().min(1),
  })

  export type Info = typeof SessionCronTable.$inferSelect

  async function withLock<T>(key: string, work: () => Promise<T>) {
    const previous = locks.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((r) => {
      release = r
    })

    const next = previous.then(() => current)
    locks.set(key, next)

    await previous
    try {
      return await work()
    } finally {
      release()
      if (locks.get(key) === next) {
        locks.delete(key)
      }
    }
  }

  export const create = fn(CreateInput, async (input) => {
    return withLock(input.sessionID, async () => {
      const count =
        Database.use((db) =>
          db
            .select({ count: sql<number>`count(*)` })
            .from(SessionCronTable)
            .where(eq(SessionCronTable.session_id, input.sessionID))
            .get(),
        )?.count ?? 0
      if (count >= SessionLoop.MAX_CRON_PER_SESSION) {
        throw new Error(
          `Session has reached the /loop job limit (${SessionLoop.MAX_CRON_PER_SESSION}). Use /loop stop first.`,
        )
      }

      const now = Date.now()
      const row: Info = {
        id: `scr_${crypto.randomUUID().replaceAll("-", "")}`,
        session_id: input.sessionID,
        interval_ms: input.interval_ms,
        prompt: input.prompt,
        next_run_at: now + input.interval_ms,
        time_created: now,
        time_updated: now,
      }
      Database.use((db) => {
        db.insert(SessionCronTable).values(row).run()
      })
      return row
    })
  })

  export const StopInput = z.object({
    sessionID: SessionID.zod,
  })

  export const stop = fn(StopInput, async (input) => {
    return withLock(input.sessionID, async () => {
      const jobs = Database.use((db) =>
        db
          .select({ id: SessionCronTable.id })
          .from(SessionCronTable)
          .where(eq(SessionCronTable.session_id, input.sessionID))
          .all(),
      )
      if (jobs.length === 0) return 0
      Database.use((db) => {
        db.delete(SessionCronTable).where(eq(SessionCronTable.session_id, input.sessionID)).run()
      })
      return jobs.length
    })
  })

  export async function listDue(now = Date.now()) {
    return Database.use((db) =>
      db
        .select()
        .from(SessionCronTable)
        .where(lte(SessionCronTable.next_run_at, now))
        .orderBy(SessionCronTable.next_run_at)
        .all(),
    )
  }

  export async function reschedule(id: string, next: number) {
    Database.use((db) => {
      db.update(SessionCronTable).set({ next_run_at: next }).where(eq(SessionCronTable.id, id)).run()
    })
  }

  export function start(poll = interval) {
    const item = state()
    if (item.timer) return
    item.timer = setInterval(() => {
      void tick().catch((error) => {
        log.warn("session cron tick failed", { error: error instanceof Error ? error.message : String(error) })
      })
    }, poll)
    item.timer.unref()
    void tick().catch((error) => {
      log.warn("session cron tick failed", { error: error instanceof Error ? error.message : String(error) })
    })
  }

  async function tick() {
    const item = state()
    if (item.busy) return
    item.busy = true
    try {
      for (const job of await listDue()) {
        await withLock(job.session_id, async () => {
          const current = Database.use((db) =>
            db.select().from(SessionCronTable).where(eq(SessionCronTable.id, job.id)).get(),
          )
          if (!current) return
          if (current.next_run_at > Date.now()) return

          await SessionPrompt.prompt({
            sessionID: current.session_id,
            parts: [
              {
                type: "text",
                text: current.prompt,
                synthetic: true,
              },
            ],
          }).catch((error) => {
            log.warn("session cron prompt failed", {
              sessionID: current.session_id,
              id: current.id,
              error: error instanceof Error ? error.message : String(error),
            })
          })

          const now = Date.now()
          await reschedule(current.id, Math.max(current.next_run_at + current.interval_ms, now + current.interval_ms))
        })
      }
    } finally {
      item.busy = false
    }
  }
}
