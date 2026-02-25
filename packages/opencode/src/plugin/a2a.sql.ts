import { index, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "@/storage/schema.sql"

export const A2ATaskTable = sqliteTable(
  "a2a_task",
  {
    id: text().primaryKey(),
    context_id: text().notNull(),
    agent_id: text().notNull(),
    session_id: text(),
    state: text().notNull(),
    message: text(),
    artifacts: text({ mode: "json" }).$type<unknown[]>(),
    history: text({ mode: "json" }).$type<unknown[]>(),
    ...Timestamps,
  },
  (table) => [
    index("a2a_task_agent_idx").on(table.agent_id),
    index("a2a_task_context_idx").on(table.context_id),
    index("a2a_task_state_idx").on(table.state),
  ],
)
