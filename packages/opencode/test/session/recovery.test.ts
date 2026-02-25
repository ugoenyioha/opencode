import { describe, expect, test } from "bun:test"
import path from "path"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Database } from "../../src/storage/db"
import { MessageTable, PartTable } from "../../src/session/session.sql"
import { Session } from "../../src/session"
import { SessionRecovery } from "../../src/session/recovery"
import { eq } from "drizzle-orm"

const projectRoot = path.join(__dirname, "../..")

describe("session recovery", () => {
  test("marks orphaned tool parts and assistant messages after restart", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})
        const messageID = Identifier.ascending("message")
        const partID = Identifier.ascending("part")
        const now = Date.now()

        Database.use((db) => {
          db.insert(MessageTable)
            .values({
              id: messageID,
              session_id: session.id,
              time_created: now,
              time_updated: now,
              data: {
                role: "assistant",
                time: { created: now },
              } as any,
            })
            .run()

          db.insert(PartTable)
            .values({
              id: partID,
              message_id: messageID,
              session_id: session.id,
              time_created: now,
              time_updated: now,
              data: {
                type: "tool",
                state: {
                  status: "running",
                },
              } as any,
            })
            .run()
        })

        const first = SessionRecovery.recover()
        expect(first.parts).toBeGreaterThanOrEqual(1)
        expect(first.messages).toBeGreaterThanOrEqual(1)

        const recoveredPart = Database.use((db) => db.select().from(PartTable).where(eq(PartTable.id, partID)).get())
        expect((recoveredPart?.data as any)?.state?.status).toBe("error")
        expect((recoveredPart?.data as any)?.state?.error).toBe("Process restarted before completion")

        const recoveredMessage = Database.use((db) =>
          db.select().from(MessageTable).where(eq(MessageTable.id, messageID)).get(),
        )
        expect((recoveredMessage?.data as any)?.time?.completed).toBeTypeOf("number")

        const second = SessionRecovery.recover()
        expect(second.parts).toBe(0)
        expect(second.messages).toBe(0)

        await Session.remove(session.id)
      },
    })
  })
})
