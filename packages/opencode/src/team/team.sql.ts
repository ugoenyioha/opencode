import { sqliteTable, text, integer, index, unique, primaryKey } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "../project/project.sql"
import { SessionTable } from "../session/session.sql"
import { Timestamps } from "@/storage/schema.sql"

export const TeamTable = sqliteTable(
  "team",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    lead_session_id: text().references(() => SessionTable.id, { onDelete: "set null" }),
    delegate: integer({ mode: "boolean" }).default(false),
    coordinator: integer({ mode: "boolean" }).default(false),
    status: text().notNull().default("active"), // "active" | "archived"
    ...Timestamps,
  },
  (table) => [
    index("team_project_idx").on(table.project_id),
    index("team_lead_session_idx").on(table.lead_session_id),
    unique("team_name_project_idx").on(table.name, table.project_id), // UNIQUE constraint per project
  ],
)

export const TeamTaskTable = sqliteTable(
  "team_task",
  {
    id: text().notNull(),
    team_id: text()
      .notNull()
      .references(() => TeamTable.id, { onDelete: "cascade" }),
    content: text().notNull(),
    status: text().notNull(), // "pending" | "in_progress" | "completed" | "cancelled" | "blocked"
    priority: text().notNull(), // "high" | "medium" | "low"
    assigned_to: text().references(() => SessionTable.id, { onDelete: "set null" }),
    depends_on: text({ mode: "json" }).$type<string[]>().default([]),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.team_id, table.id] }),
    index("team_task_team_idx").on(table.team_id),
    index("team_task_assigned_idx").on(table.assigned_to),
    index("team_task_status_idx").on(table.status), // For atomic claim queries
  ],
)

export const TeamMessageTable = sqliteTable(
  "team_message",
  {
    id: text().primaryKey(),
    team_id: text()
      .notNull()
      .references(() => TeamTable.id, { onDelete: "cascade" }),
    from_session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    to_session_id: text().references(() => SessionTable.id, { onDelete: "set null" }), // SET NULL for message history preservation
    content: text().notNull(),
    read_by: text({ mode: "json" }).$type<string[]>().default([]), // Session IDs that have read this message
    ...Timestamps,
  },
  (table) => [
    index("team_message_team_idx").on(table.team_id),
    index("team_message_from_idx").on(table.from_session_id),
    index("team_message_to_idx").on(table.to_session_id),
  ],
)
