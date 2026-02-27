import { sql } from "drizzle-orm"
import { Database, eq } from "@/storage/db"
import { Log } from "@/util/log"
import { MessageTable, PartTable } from "./session.sql"

const log = Log.create({ service: "session.recovery" })

export namespace SessionRecovery {
  export function recover() {
    const orphaned = Database.use((db) =>
      db
        .select()
        .from(PartTable)
        .where(
          sql`json_extract(${PartTable.data}, '$.type') = 'tool' and json_extract(${PartTable.data}, '$.state.status') in ('running', 'pending')`,
        )
        .all(),
    )

    const now = Date.now()
    for (const part of orphaned) {
      const data = part.data as any
      Database.use((db) =>
        db
          .update(PartTable)
          .set({
            data: {
              ...data,
              state: {
                ...data.state,
                status: "error",
                error: "Process restarted before completion",
                time: {
                  start: data.state?.time?.start ?? now,
                  end: now,
                },
              },
            },
            time_updated: now,
          })
          .where(eq(PartTable.id, part.id))
          .run(),
      )
    }

    const incomplete = Database.use((db) =>
      db
        .select()
        .from(MessageTable)
        .where(
          sql`json_extract(${MessageTable.data}, '$.role') = 'assistant' and json_extract(${MessageTable.data}, '$.time.completed') is null`,
        )
        .all(),
    )

    for (const message of incomplete) {
      const data = message.data as any
      Database.use((db) =>
        db
          .update(MessageTable)
          .set({
            data: {
              ...data,
              time: {
                ...data.time,
                completed: now,
              },
            },
            time_updated: now,
          })
          .where(eq(MessageTable.id, message.id))
          .run(),
      )
    }

    if (orphaned.length > 0 || incomplete.length > 0) {
      log.info("session recovery complete", {
        parts: orphaned.length,
        messages: incomplete.length,
      })
    }

    return {
      parts: orphaned.length,
      messages: incomplete.length,
    }
  }
}
