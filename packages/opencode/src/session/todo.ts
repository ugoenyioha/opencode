import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import z from "zod"
import { Storage } from "../storage/storage"
import { Log } from "../util/log"
import type { MessageV2 } from "./message-v2"

const log = Log.create({ service: "todo" })

export namespace Todo {
  export const Status = z.enum(["pending", "in_progress", "completed", "cancelled", "blocked"])
  export type Status = z.infer<typeof Status>

  export const Priority = z.enum(["high", "medium", "low"])
  export type Priority = z.infer<typeof Priority>

  export const Info = z
    .object({
      content: z.string().describe("Brief description of the task"),
      status: Status.describe("Current status of the task: pending, in_progress, completed, cancelled, blocked"),
      priority: Priority.describe("Priority level of the task: high, medium, low"),
      id: z.string().describe("Unique identifier for the todo item"),
      depends_on: z
        .array(z.string())
        .optional()
        .describe("IDs of tasks that must be completed before this task can start"),
    })
    .meta({ ref: "Todo" })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: BusEvent.define(
      "todo.updated",
      z.object({
        sessionID: z.string(),
        todos: z.array(Info),
      }),
    ),
  }

  /** Check if a todo has unresolved dependencies */
  function hasUnresolvedDeps(todo: Info, todos: Info[]): boolean {
    if (!todo.depends_on || todo.depends_on.length === 0) return false
    return todo.depends_on.some((depId) => {
      const dep = todos.find((t) => t.id === depId)
      return !dep || dep.status !== "completed"
    })
  }

  /** Detect circular dependencies. Returns true if circular. */
  function hasCircularDeps(todos: Info[]): boolean {
    const graph = new Map<string, string[]>()
    for (const todo of todos) {
      graph.set(todo.id, todo.depends_on ?? [])
    }

    const visited = new Set<string>()
    const inStack = new Set<string>()

    function dfs(id: string): boolean {
      if (inStack.has(id)) return true
      if (visited.has(id)) return false
      visited.add(id)
      inStack.add(id)
      for (const dep of graph.get(id) ?? []) {
        if (dfs(dep)) return true
      }
      inStack.delete(id)
      return false
    }

    for (const todo of todos) {
      if (dfs(todo.id)) return true
    }
    return false
  }

  /**
   * Resolve dependency states:
   * - If a todo has depends_on with incomplete deps, set status to "blocked"
   * - If a blocked todo's deps are all completed, set status to "pending"
   * - Strip depends_on references to non-existent IDs
   */
  function resolveDependencies(todos: Info[]): Info[] {
    const ids = new Set(todos.map((t) => t.id))
    return todos.map((todo) => {
      // Strip references to non-existent IDs
      if (todo.depends_on && todo.depends_on.length > 0) {
        const filtered = todo.depends_on.filter((id) => ids.has(id))
        if (filtered.length === 0) {
          const { depends_on: _, ...rest } = todo
          todo = rest as Info
        } else {
          todo = { ...todo, depends_on: filtered }
        }
      }

      if (hasUnresolvedDeps(todo, todos)) {
        // Task has unresolved deps — should be blocked
        if (todo.status === "pending" || todo.status === "in_progress") {
          return { ...todo, status: "blocked" as const }
        }
      } else if (todo.status === "blocked") {
        // Deps resolved — unblock
        return { ...todo, status: "pending" as const }
      }
      return todo
    })
  }

  export async function update(input: { sessionID: string; todos: Info[] }) {
    // Warn on circular dependencies but don't block
    if (hasCircularDeps(input.todos)) {
      log.warn("circular dependency detected in todo list", { sessionID: input.sessionID })
    }

    const resolved = resolveDependencies(input.todos)
    await Storage.write(["todo", input.sessionID], resolved)
    Bus.publish(Event.Updated, { sessionID: input.sessionID, todos: resolved })
  }

  export async function get(sessionID: string) {
    return Storage.read<Info[]>(["todo", sessionID])
      .then((x) => x || [])
      .catch(() => [])
  }

  /** Returns the current todo list as a system prompt string, or empty array if no todos. */
  export async function systemContext(sessionID: string, messages: MessageV2.WithParts[]): Promise<string[]> {
    const todos = await get(sessionID)
    if (todos.length === 0) return []
    const incomplete = todos.filter((t) => t.status !== "completed" && t.status !== "cancelled")
    if (incomplete.length === 0) return []

    // Check if any visible message has a todowrite tool call
    const hasTodoWrite = messages.some((m) =>
      m.parts.some((p) => p.type === "tool" && p.tool === "todowrite"),
    )

    const json = JSON.stringify(incomplete, null, 2)
    if (hasTodoWrite) {
      return ["Current task list:\n" + json]
    }
    return [
      "Current task list (restored from storage — call todowrite to update task statuses as you work):\n" + json,
    ]
  }
}
