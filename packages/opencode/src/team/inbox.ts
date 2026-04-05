import { Log } from "../util/log"
import { Instance } from "../project/instance"
import { Bus } from "../bus"
import { Config } from "../config/config"
import { Database, and, eq, or, sql, isNull, inArray } from "../storage/db"
import { TeamEvent } from "./events"
import { TeamMessageTable, TeamTable } from "./team.sql"
import { SessionTable } from "../session/session.sql"

const log = Log.create({ service: "team.inbox" })

export interface InboxMessage {
  id: string
  from: string
  text: string
  timestamp: number
  read: boolean
}

function team(teamName: string) {
  return Database.use((db) =>
    db
      .select()
      .from(TeamTable)
      .where(
        and(
          eq(TeamTable.project_id, Instance.project.id),
          eq(TeamTable.name, teamName),
          eq(TeamTable.status, "active"),
        ),
      )
      .get(),
  )
}

function sessionID(teamID: string, agentName: string) {
  if (agentName === "lead") {
    return Database.use((db) =>
      db
        .select({ id: TeamTable.lead_session_id })
        .from(TeamTable)
        .where(and(eq(TeamTable.id, teamID), eq(TeamTable.project_id, Instance.project.id)))
        .get(),
    )?.id
  }
  return Database.use((db) =>
    db
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(
        and(
          eq(SessionTable.team_id, teamID),
          eq(SessionTable.team_role, "member"),
          sql`json_extract(${SessionTable.team_meta}, '$.name') = ${agentName}`,
        ),
      )
      .get(),
  )?.id
}

function nameBySession(id: string) {
  return (
    Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, id)).get())?.team_meta?.name ?? "lead"
  )
}

function unreadWhere(teamID: string, sid: string) {
  return and(
    eq(TeamMessageTable.team_id, teamID),
    or(eq(TeamMessageTable.to_session_id, sid), isNull(TeamMessageTable.to_session_id)),
    sql`NOT EXISTS (SELECT 1 FROM json_each(${TeamMessageTable.read_by}) WHERE json_each.value = ${sid})`,
  )
}

function toInbox(rows: (typeof TeamMessageTable.$inferSelect)[]): InboxMessage[] {
  return rows.map((row) => ({
    id: row.id,
    from: nameBySession(row.from_session_id),
    text: row.content,
    timestamp: row.time_created,
    read: false,
  }))
}

/**
 * Per-member message inbox backed by the team_message table.
 * Source of truth for all team messages — session injection is the delivery mechanism.
 */
export namespace Inbox {
  /** Write a message to a recipient's inbox. Resolves agent names to session IDs. */
  export async function write(teamName: string, to: string, message: Omit<InboxMessage, "read">): Promise<void> {
    const match = team(teamName)
    if (!match) throw new Error(`Team "${teamName}" not found`)
    const toSession = sessionID(match.id, to)
    if (!toSession) throw new Error(`Recipient "${to}" not found`)
    const fromSession = sessionID(match.id, message.from)
    if (!fromSession) throw new Error(`Sender "${message.from}" not found`)

    // Enforce max_team_messages to prevent unbounded inbox growth
    const limit = 1000
    const count =
      Database.use((db) =>
        db
          .select({ count: sql<number>`count(*)` })
          .from(TeamMessageTable)
          .where(eq(TeamMessageTable.team_id, match.id))
          .get(),
      )?.count ?? 0
    if (count >= limit) {
      throw new Error(
        `Team "${teamName}" has reached the message limit (${limit}). Clean up old messages or increase the limit.`,
      )
    }

    Database.use((db) => {
      db.insert(TeamMessageTable)
        .values({
          id: message.id,
          team_id: match.id,
          from_session_id: fromSession,
          to_session_id: toSession,
          content: message.text,
          read_by: [],
          time_created: message.timestamp,
          time_updated: message.timestamp,
        })
        .run()
    })
    log.info("inbox write", { teamName, to, from: message.from, id: message.id })
  }

  /** Get all unread messages for a team participant */
  export async function unread(teamName: string, agentName: string): Promise<InboxMessage[]> {
    const match = team(teamName)
    if (!match) return []
    const sid = sessionID(match.id, agentName)
    if (!sid) return []
    const rows = Database.use((db) =>
      db.select().from(TeamMessageTable).where(unreadWhere(match.id, sid)).orderBy(TeamMessageTable.time_created).all(),
    )
    return toInbox(rows)
  }

  /** Get all messages (read and unread) for a team participant */
  export async function all(teamName: string, agentName: string): Promise<InboxMessage[]> {
    const match = team(teamName)
    if (!match) return []
    const sid = sessionID(match.id, agentName)
    if (!sid) return []
    const rows = Database.use((db) =>
      db
        .select()
        .from(TeamMessageTable)
        .where(
          and(
            eq(TeamMessageTable.team_id, match.id),
            or(eq(TeamMessageTable.to_session_id, sid), isNull(TeamMessageTable.to_session_id)),
          ),
        )
        .orderBy(TeamMessageTable.time_created)
        .all(),
    )
    const unreadIDs = new Set((await unread(teamName, agentName)).map((x) => x.id))
    return rows.map((row) => ({
      id: row.id,
      from: nameBySession(row.from_session_id),
      text: row.content,
      timestamp: row.time_created,
      read: !unreadIDs.has(row.id),
    }))
  }

  /** Mark all unread messages as read. Returns the messages that were marked. */
  export async function markRead(teamName: string, agentName: string): Promise<InboxMessage[]> {
    const match = team(teamName)
    if (!match) return []
    const sid = sessionID(match.id, agentName)
    if (!sid) return []
    const rows = Database.use((db) =>
      db.select().from(TeamMessageTable).where(unreadWhere(match.id, sid)).orderBy(TeamMessageTable.time_created).all(),
    )
    if (!rows.length) return []
    Database.use((db) => {
      for (const row of rows) {
        const next = [...new Set([...(row.read_by ?? []), sid])]
        db.update(TeamMessageTable)
          .set({ read_by: next, time_updated: Date.now() })
          .where(eq(TeamMessageTable.id, row.id))
          .run()
      }
    })
    log.info("inbox marked read", { teamName, agentName, count: rows.length })
    await Bus.publish(TeamEvent.MessageRead, { teamName, agentName, count: rows.length })
    return toInbox(rows)
  }

  /** Remove all messages addressed to a specific agent */
  export async function remove(teamName: string, agentName: string): Promise<void> {
    const match = team(teamName)
    if (!match) return
    const sid = sessionID(match.id, agentName)
    if (!sid) return
    Database.use((db) => {
      db.delete(TeamMessageTable)
        .where(and(eq(TeamMessageTable.team_id, match.id), eq(TeamMessageTable.to_session_id, sid)))
        .run()
    })
  }

  /** Remove all messages for multiple agents at once (used during team cleanup) */
  export async function removeAll(teamName: string, agentNames: string[]): Promise<void> {
    const match = team(teamName)
    if (!match) return
    const ids = [
      ...new Set([...agentNames, "lead"].map((name) => sessionID(match.id, name)).filter((x): x is string => !!x)),
    ]
    if (!ids.length) return
    Database.use((db) => {
      db.delete(TeamMessageTable)
        .where(and(eq(TeamMessageTable.team_id, match.id), inArray(TeamMessageTable.to_session_id, ids)))
        .run()
    })
  }
}
