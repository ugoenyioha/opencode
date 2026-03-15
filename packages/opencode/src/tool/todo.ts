import z from "zod"
import { Tool } from "./tool"
import { Todo } from "../session/todo"
import DESCRIPTION_CREATE from "./session_task_create.txt"
import DESCRIPTION_UPDATE from "./session_task_update.txt"
import DESCRIPTION_GET from "./session_task_get.txt"
import DESCRIPTION_LIST from "./session_task_list.txt"

/**
 * Deprecated stub — kept so old sessions with "todowrite" in their
 * conversation history don't crash on resume.
 */
export const TodoWriteTool = Tool.define("todowrite", {
  description:
    "Deprecated. Use session_task_create, session_task_update, session_task_get, or session_task_list instead.",
  parameters: z.object({
    todos: z.array(z.any()).optional().describe("Deprecated"),
  }),
  async execute(_params, _ctx) {
    return {
      title: "Deprecated",
      output:
        "The todowrite tool has been deprecated. Use session_task_create, session_task_update, session_task_get, or session_task_list instead.",
      metadata: {
        todos: [] as Todo.Info[],
      },
    }
  },
})

export const TodoReadTool = Tool.define("todoread", {
  description: "Deprecated. Use session_task_list or session_task_get instead.",
  parameters: z.object({}),
  async execute(_params, _ctx) {
    return {
      title: "Deprecated",
      output: "The todoread tool has been deprecated. Use session_task_list or session_task_get instead.",
      metadata: {},
    }
  },
})

export const SessionTaskCreateTool = Tool.define("session_task_create", {
  description: DESCRIPTION_CREATE,
  parameters: z.object({
    id: z.string().max(64).describe("Short, semantic task identifier (e.g., 'setup-db', 'auth-api')"),
    content: z.string().max(2000).describe("Brief description of the task"),
    priority: Todo.Priority.describe("Priority level: high, medium, low"),
    depends_on: z
      .array(z.string())
      .max(50)
      .optional()
      .describe("IDs of tasks that must be completed before this task can start"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "session_task_create",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })

    const task = await Todo.createTask({
      sessionID: ctx.sessionID,
      id: params.id,
      content: params.content,
      priority: params.priority,
      depends_on: params.depends_on,
    })
    return {
      title: `Created task ${task.id}`,
      output: JSON.stringify(task, null, 2),
      metadata: { task },
    }
  },
})

export const SessionTaskUpdateTool = Tool.define("session_task_update", {
  description: DESCRIPTION_UPDATE,
  parameters: z.object({
    id: z.string().max(64).describe("ID of the task to update"),
    status: Todo.SettableStatus.or(z.literal("deleted"))
      .optional()
      .describe("New status: pending, in_progress, completed, cancelled, deleted"),
    content: z.string().max(2000).optional().describe("Updated task description"),
    priority: Todo.Priority.optional().describe("Updated priority: high, medium, low"),
    depends_on: z.array(z.string()).max(50).optional().describe("Updated dependency list"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "session_task_update",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })

    if (params.status === "deleted") {
      await Todo.deleteTask({
        sessionID: ctx.sessionID,
        id: params.id,
      })
      return {
        title: `Deleted task ${params.id}`,
        output: `Task ${params.id} deleted.`,
        metadata: { deleted: true, id: params.id } as Record<string, unknown>,
      }
    }

    const task = await Todo.updateTask({
      sessionID: ctx.sessionID,
      id: params.id,
      status: params.status,
      content: params.content,
      priority: params.priority,
      depends_on: params.depends_on,
    })
    return {
      title: `Updated task ${task.id}`,
      output: JSON.stringify(task, null, 2),
      metadata: { deleted: false, id: task.id, task } as Record<string, unknown>,
    }
  },
})

export const SessionTaskGetTool = Tool.define("session_task_get", {
  description: DESCRIPTION_GET,
  parameters: z.object({
    id: z.string().max(64).describe("ID of the task to retrieve"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "session_task_get",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })

    const todos = await Todo.get(ctx.sessionID)
    const task = todos.find((t) => t.id === params.id)
    if (!task) {
      return {
        title: "Task not found",
        output: `No task found with id: ${params.id}`,
        metadata: {} as Record<string, unknown>,
      }
    }
    return {
      title: `Task ${task.id}`,
      output: JSON.stringify(task, null, 2),
      metadata: {} as Record<string, unknown>,
    }
  },
})

export const SessionTaskListTool = Tool.define("session_task_list", {
  description: DESCRIPTION_LIST,
  parameters: z.object({
    status: Todo.Status.optional().describe("Optional status filter"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "session_task_list",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })

    const todos = await Todo.get(ctx.sessionID)
    const filtered = params.status ? todos.filter((t) => t.status === params.status) : todos
    const count = filtered.filter((t) => t.status !== "completed").length
    return {
      title: `${count} tasks`,
      output: JSON.stringify(filtered, null, 2),
      metadata: { todos: filtered },
    }
  },
})
