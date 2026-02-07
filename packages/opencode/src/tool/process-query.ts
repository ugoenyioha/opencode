import z from "zod"
import { Tool } from "./tool"
import { TaskManager, type TaskInfo } from "../task"

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function resolveTask(identifier: string, tasks: TaskInfo[]): TaskInfo | undefined {
  if (identifier.toLowerCase() === "last") {
    return tasks.length > 0
      ? tasks.reduce((latest, t) => (t.startTime > latest.startTime ? t : latest), tasks[0])
      : undefined
  }
  return (
    tasks.find((t) => t.id === identifier) ??
    tasks.find((t) => t.id.includes(identifier)) ??
    tasks.find((t) => t.description?.toLowerCase().includes(identifier.toLowerCase())) ??
    tasks.find((t) => t.command.toLowerCase().includes(identifier.toLowerCase()))
  )
}

type Result = {
  title: string
  metadata: { [key: string]: any }
  output: string
}

export const ProcessQueryTool = Tool.define("process_query", {
  description: `Query and interact with background processes.

Use this tool to:
- Check the status of background tasks
- Read output from background tasks
- Search for patterns in task output
- List all background tasks

Available actions:
- "list": List all background tasks
- "status": Get the current status of a task
- "read_output": Read the full output of a task
- "read_last_n": Read the last N lines of output
- "search": Search for a pattern in the task output

The identifier can be a task ID, "last" for the most recent task, or a partial match of the description/command.`,
  parameters: z.object({
    action: z
      .enum(["status", "read_output", "read_last_n", "search", "list"])
      .describe("The action to perform"),
    identifier: z
      .string()
      .describe('Task identifier: task ID, "last", or partial description match. Not required for "list".')
      .optional(),
    lines: z.number().describe("Number of lines for read_last_n (default: 50)").optional(),
    pattern: z.string().describe("Search pattern for search action").optional(),
  }),
  async execute(params, _ctx): Promise<Result> {
    if (params.action === "list") {
      const tasks = TaskManager.list()
      if (tasks.length === 0) {
        return { title: "List background tasks", metadata: {}, output: "No background tasks." }
      }
      const list = tasks
        .map((t) => {
          const dur =
            t.status === "running"
              ? `running ${formatDuration(Date.now() - t.startTime)}`
              : `${t.status}${t.exitCode !== undefined ? ` (exit: ${t.exitCode})` : ""}`
          return `- ${t.id}: ${t.description || t.command.slice(0, 60)} [${dur}]`
        })
        .join("\n")
      return { title: "List background tasks", metadata: {}, output: `${tasks.length} background task(s):\n\n${list}` }
    }

    if (!params.identifier) {
      return {
        title: "Process query error",
        metadata: {},
        output: 'Error: identifier required. Use "last" for most recent, or a task ID.',
      }
    }

    const tasks = TaskManager.list()
    const task = resolveTask(params.identifier, tasks)
    if (!task) {
      return {
        title: "Process query error",
        metadata: {},
        output: `No task matching "${params.identifier}". Use action "list" to see available tasks.`,
      }
    }

    switch (params.action) {
      case "status": {
        const dur = formatDuration(Date.now() - task.startTime)
        const info = [
          `Task ID: ${task.id}`,
          `Command: ${task.command}`,
          `Status: ${task.status}`,
          `PID: ${task.pid}`,
          `Duration: ${dur}`,
          task.description ? `Description: ${task.description}` : null,
          task.exitCode !== undefined ? `Exit Code: ${task.exitCode}` : null,
        ]
          .filter(Boolean)
          .join("\n")
        return { title: `Status: ${task.description || task.id}`, metadata: {}, output: info }
      }

      case "read_output": {
        const output = TaskManager.read(task.id) ?? "(No output)"
        return { title: `Output: ${task.description || task.id}`, metadata: {}, output }
      }

      case "read_last_n": {
        const n = params.lines ?? 50
        const output = TaskManager.tail(task.id, n) ?? "(No output)"
        return { title: `Last ${n} lines: ${task.description || task.id}`, metadata: {}, output }
      }

      case "search": {
        if (!params.pattern) {
          return { title: "Process query error", metadata: {}, output: "Error: pattern required for search action." }
        }
        const output = TaskManager.read(task.id)
        if (!output) {
          return { title: `Search: ${task.description || task.id}`, metadata: {}, output: "(No output to search)" }
        }
        const matches = output
          .split("\n")
          .map((line, idx) => ({ line, num: idx + 1 }))
          .filter(({ line }) => line.toLowerCase().includes(params.pattern!.toLowerCase()))
        if (matches.length === 0) {
          return {
            title: `Search: ${task.description || task.id}`,
            metadata: {},
            output: `No matches for "${params.pattern}"`,
          }
        }
        return {
          title: `Search: ${task.description || task.id}`,
          metadata: {},
          output: `${matches.length} match(es):\n\n${matches.map((m) => `${m.num}: ${m.line}`).join("\n")}`,
        }
      }

      default:
        return { title: "Process query error", metadata: {}, output: `Unknown action: ${params.action}` }
    }
  },
})
