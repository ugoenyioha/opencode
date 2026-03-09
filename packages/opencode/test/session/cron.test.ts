import { describe, expect, spyOn, test } from "bun:test"
import path from "path"
import { SessionCron } from "../../src/session/cron"
import { SessionPrompt } from "../../src/session/prompt"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Database, eq } from "../../src/storage/db"
import { SessionCronTable } from "../../src/session/session.sql"
import { Log } from "../../src/util/log"

const root = path.join(__dirname, "../..")
Log.init({ print: false })

async function wait(check: () => boolean | Promise<boolean>, timeout = 2000, delay = 20) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
  throw new Error("timed out")
}

describe("session cron", () => {
  test("validates schedule creation", async () => {
    await Instance.disposeAll()
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})

        expect(() =>
          SessionCron.create({
            sessionID: session.id,
            interval_ms: 0,
            prompt: "ping",
          }),
        ).toThrow()

        expect(() =>
          SessionCron.create({
            sessionID: session.id,
            interval_ms: 60_000,
            prompt: "",
          }),
        ).toThrow()
      },
    })
  })

  test("runs due job and reschedules next run", async () => {
    await Instance.disposeAll()
    await Instance.provide({
      directory: root,
      fn: async () => {
        const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue(undefined as any)
        try {
          const session = await Session.create({})
          const job = await SessionCron.create({
            sessionID: session.id,
            interval_ms: 60_000,
            prompt: "ping",
          })

          Database.use((db) => {
            db.update(SessionCronTable)
              .set({ next_run_at: Date.now() - 1 })
              .where(eq(SessionCronTable.id, job.id))
              .run()
          })

          SessionCron.start(10)

          await wait(() => prompt.mock.calls.length > 0)

          const row = Database.use((db) =>
            db.select().from(SessionCronTable).where(eq(SessionCronTable.id, job.id)).get(),
          )

          expect(prompt).toHaveBeenCalled()
          expect(row).toBeDefined()
          expect(row!.next_run_at).toBeGreaterThan(Date.now())
        } finally {
          await Instance.dispose()
          prompt.mockRestore()
        }
      },
    })
  })

  test("enforces per-session cron job cap", async () => {
    await Instance.disposeAll()
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        for (let i = 0; i < 10; i++) {
          await SessionCron.create({
            sessionID: session.id,
            interval_ms: 60_000,
            prompt: `ping ${i}`,
          })
        }
        await expect(
          SessionCron.create({
            sessionID: session.id,
            interval_ms: 60_000,
            prompt: "overflow",
          }),
        ).rejects.toThrow("/loop job limit")
      },
    })
  })

  test("enforces cap under concurrent creates", async () => {
    await Instance.disposeAll()
    await Instance.provide({
      directory: root,
      fn: async () => {
        const session = await Session.create({})
        const results = await Promise.allSettled(
          Array.from({ length: 15 }).map((_, i) =>
            SessionCron.create({
              sessionID: session.id,
              interval_ms: 60_000,
              prompt: `p-${i}`,
            }),
          ),
        )
        const ok = results.filter((x) => x.status === "fulfilled").length
        const bad = results.filter((x) => x.status === "rejected").length
        expect(ok).toBe(10)
        expect(bad).toBe(5)
      },
    })
  })
})
