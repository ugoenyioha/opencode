import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import z from "zod"
import { Storage } from "../storage/storage"
import { Log } from "../util/log"
import type { MessageV2 } from "./message-v2"

const log = Log.create({ service: "todo" })
const locks = new Map<string, Promise<void>>()

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((r) => {
    release = r
  })

  const next = previous.then(() => current)
  locks.set(key, next)

  await previous
  try {
    return await fn()
  } finally {
    release()
    if (locks.get(key) === next) {
      locks.delete(key)
    }
  }
}

export namespace Todo {
  export const Status = z.enum(["pending", "in_progress", "completed", "cancelled", "blocked"])
  export type Status = z.infer<typeof Status>

  /** Status values the LLM is allowed to set — "blocked" is managed by dependency resolution */
  export const SettableStatus = z.enum(["pending", "in_progress", "completed", "cancelled"])
  export type SettableStatus = z.infer<typeof SettableStatus>

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
    await withLock(input.sessionID, async () => {
      // Warn on circular dependencies but don't block
      if (hasCircularDeps(input.todos)) {
        log.warn("circular dependency detected in todo list", { sessionID: input.sessionID })
      }

      const resolved = resolveDependencies(input.todos)
      await Storage.write(["todo", input.sessionID], resolved)
      Bus.publish(Event.Updated, { sessionID: input.sessionID, todos: resolved })
    })
  }

  export async function createTask(input: {
    sessionID: string
    id: string
    content: string
    priority: Priority
    depends_on?: string[]
  }): Promise<Info> {
    return withLock(input.sessionID, async () => {
      const list = await get(input.sessionID)
      if (list.some((x) => x.id === input.id)) {
        throw new Error(`Task already exists: ${input.id}`)
      }
      const task = {
        id: input.id,
        content: input.content,
        status: "pending" as const,
        priority: input.priority,
        ...(input.depends_on !== undefined ? { depends_on: input.depends_on } : {}),
      }
      const next = [...list, task]

      if (hasCircularDeps(next)) {
        log.warn("circular dependency detected in todo list", { sessionID: input.sessionID })
      }

      const resolved = resolveDependencies(next)
      await Storage.write(["todo", input.sessionID], resolved)
      Bus.publish(Event.Updated, { sessionID: input.sessionID, todos: resolved })

      const todo = resolved.find((x) => x.id === input.id)
      if (todo) return todo
      return task
    })
  }

  export async function updateTask(input: {
    sessionID: string
    id: string
    status?: SettableStatus
    content?: string
    priority?: Priority
    depends_on?: string[]
  }): Promise<Info> {
    return withLock(input.sessionID, async () => {
      const list = await get(input.sessionID)
      const i = list.findIndex((x) => x.id === input.id)
      if (i < 0) {
        throw new Error(`Todo task not found: ${input.id}`)
      }

      const todo = list[i]
      const task = {
        ...todo,
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.content !== undefined ? { content: input.content } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.depends_on !== undefined ? { depends_on: input.depends_on } : {}),
      }
      const next = list.map((x) => {
        if (x.id === input.id) return task
        return x
      })

      if (hasCircularDeps(next)) {
        log.warn("circular dependency detected in todo list", { sessionID: input.sessionID })
      }

      const resolved = resolveDependencies(next)
      await Storage.write(["todo", input.sessionID], resolved)
      Bus.publish(Event.Updated, { sessionID: input.sessionID, todos: resolved })

      const result = resolved.find((x) => x.id === input.id)
      if (result) return result
      throw new Error(`Todo task not found: ${input.id}`)
    })
  }

  export async function deleteTask(input: { sessionID: string; id: string }): Promise<void> {
    await withLock(input.sessionID, async () => {
      const list = await get(input.sessionID)
      const next = list.filter((x) => x.id !== input.id)

      if (hasCircularDeps(next)) {
        log.warn("circular dependency detected in todo list", { sessionID: input.sessionID })
      }

      const resolved = resolveDependencies(next)
      await Storage.write(["todo", input.sessionID], resolved)
      Bus.publish(Event.Updated, { sessionID: input.sessionID, todos: resolved })
    })
  }

  export async function append(input: { sessionID: string; todo: Omit<Info, "id"> & { id?: string } }) {
    return withLock(input.sessionID, async () => {
      const list = await get(input.sessionID)
      const id = input.todo.id ?? `btw-${list.filter((x) => x.id.startsWith("btw-")).length + 1}`
      const next = [
        ...list,
        {
          id,
          content: input.todo.content,
          status: input.todo.status,
          priority: input.todo.priority,
          ...(input.todo.depends_on ? { depends_on: input.todo.depends_on } : {}),
        },
      ]
      if (hasCircularDeps(next)) {
        log.warn("circular dependency detected in todo list", { sessionID: input.sessionID })
      }
      const resolved = resolveDependencies(next)
      await Storage.write(["todo", input.sessionID], resolved)
      Bus.publish(Event.Updated, { sessionID: input.sessionID, todos: resolved })
      return resolved.find((x) => x.id === id)
    })
  }

  export async function get(sessionID: string) {
    return Storage.read<Info[]>(["todo", sessionID])
      .then((x) => x || [])
      .catch(() => [])
  }

  const TASK_TOOLS = new Set([
    "todowrite",
    "session_task_create",
    "session_task_update",
    "session_task_get",
    "session_task_list",
  ])

  /** Returns the current todo list as a system prompt string, or empty array if no todos. */
  export async function systemContext(sessionID: string, messages: MessageV2.WithParts[]): Promise<string[]> {
    const todos = await get(sessionID)
    if (todos.length === 0) return []
    const incomplete = todos.filter((t) => t.status !== "completed" && t.status !== "cancelled")
    if (incomplete.length === 0) return []

    const hasTools = messages.some((m) => m.parts.some((p) => p.type === "tool" && TASK_TOOLS.has(p.tool)))

    const lines = incomplete.map((t) => {
      const deps = t.depends_on?.length ? ` (depends on: ${t.depends_on.join(", ")})` : ""
      return `- [${t.id}] [${t.status}] ${t.priority.toUpperCase()}: ${t.content}${deps}`
    })
    const md = lines.join("\n")

    if (hasTools) {
      return ["Current task list:\n" + md]
    }
    return [
      "Current task list (restored from storage — use session_task_update to update statuses as you work):\n" + md,
    ]
  }
}
