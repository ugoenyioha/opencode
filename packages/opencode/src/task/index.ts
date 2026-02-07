import { type ChildProcess } from "child_process"
import { randomBytes } from "crypto"
import { Log } from "../util/log"
import { Instance } from "../project/instance"
import { Bus } from "../bus"
import { Shell } from "../shell/shell"
import { TaskEvent, type TaskInfo, type TaskStatus } from "./events"

export { TaskEvent, TaskInfoSchema, type TaskInfo, type TaskStatus } from "./events"

const log = Log.create({ service: "task" })

const MAX_OUTPUT_BYTES = 5 * 1024 * 1024 // 5 MB output cap per task

interface ManagedTask extends TaskInfo {
  process: ChildProcess
  output: string
  /** Set when kill() is called to prevent the exit handler from overwriting status */
  killed?: boolean
}

function generateId(): string {
  return `task_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`
}

const state = Instance.state(
  () => new Map<string, ManagedTask>(),
  async (tasks) => {
    // Kill all background tasks on shutdown
    for (const task of tasks.values()) {
      if (task.status === "running") {
        try {
          task.process.kill()
        } catch {}
      }
    }
    tasks.clear()
  },
)

function attachHandlers(task: ManagedTask) {
  task.process.stdout?.on("data", (chunk: Buffer) => {
    const data = chunk.toString()
    if (task.output.length < MAX_OUTPUT_BYTES) {
      task.output += data
      if (task.output.length >= MAX_OUTPUT_BYTES) {
        task.output += "\n\n[Output truncated at 5MB]\n"
      }
    }
    Bus.publish(TaskEvent.Output, {
      id: task.id,
      data,
      isError: false,
    }).catch(() => {})
  })

  task.process.stderr?.on("data", (chunk: Buffer) => {
    const data = chunk.toString()
    if (task.output.length < MAX_OUTPUT_BYTES) {
      task.output += data
      if (task.output.length >= MAX_OUTPUT_BYTES) {
        task.output += "\n\n[Output truncated at 5MB]\n"
      }
    }
    Bus.publish(TaskEvent.Output, {
      id: task.id,
      data,
      isError: true,
    }).catch(() => {})
  })

  task.process.on("exit", (code) => {
    // If already killed, don't overwrite the status or emit duplicate events
    if (task.killed) return
    task.exitCode = code ?? undefined
    task.status = code === 0 ? "completed" : "failed"
    log.info("task completed", { taskId: task.id, exitCode: code, status: task.status })
    Bus.publish(TaskEvent.Completed, {
      id: task.id,
      exitCode: code,
      status: task.status,
    }).catch(() => {})
  })

  task.process.once("error", (err) => {
    log.info("task error", { taskId: task.id, error: err.message })
    task.status = "failed"
    Bus.publish(TaskEvent.Completed, {
      id: task.id,
      exitCode: null,
      status: "failed",
    }).catch(() => {})
  })
}

function toInfo(task: ManagedTask): TaskInfo {
  return {
    id: task.id,
    pid: task.pid,
    command: task.command,
    startTime: task.startTime,
    status: task.status,
    exitCode: task.exitCode,
    workdir: task.workdir,
    description: task.description,
  }
}

export namespace TaskManager {
  /**
   * Adopt an already-running ChildProcess as a background task.
   * Used when migrating a foreground bash command to the background.
   */
  export async function adopt(input: {
    process: ChildProcess
    command: string
    workdir: string
    description: string
    initialOutput: string
    startTime: number
  }): Promise<TaskInfo> {
    const id = generateId()

    log.info("adopting process", { taskId: id, pid: input.process.pid, command: input.command })

    const task: ManagedTask = {
      id,
      pid: input.process.pid!,
      command: input.command,
      startTime: input.startTime,
      status: "running",
      workdir: input.workdir,
      description: input.description,
      process: input.process,
      output: input.initialOutput,
    }

    state().set(id, task)
    attachHandlers(task)

    // Guard against TOCTOU: if the process already exited before we attached handlers,
    // sync the status now so we don't leave a permanently "running" zombie task
    if (task.status === "running" && input.process.exitCode !== null) {
      task.exitCode = input.process.exitCode
      task.status = input.process.exitCode === 0 ? "completed" : "failed"
    }

    await Bus.publish(TaskEvent.Created, { info: toInfo(task) })

    return toInfo(task)
  }

  export function list(): TaskInfo[] {
    return Array.from(state().values()).map(toInfo)
  }

  export function get(taskId: string): TaskInfo | undefined {
    const task = state().get(taskId)
    if (!task) return undefined

    // Sync status if process exited but event hasn't fired
    if (task.status === "running" && task.process.exitCode !== null) {
      task.exitCode = task.process.exitCode
      task.status = task.process.exitCode === 0 ? "completed" : "failed"
    }

    return toInfo(task)
  }

  export async function kill(taskId: string): Promise<boolean> {
    const task = state().get(taskId)
    if (!task || task.status !== "running") return false

    log.info("killing task", { taskId, pid: task.pid })

    let exited = false
    task.process.once("exit", () => {
      exited = true
    })
    task.killed = true
    await Shell.killTree(task.process, { exited: () => exited })

    task.status = "failed"
    task.exitCode = task.process.exitCode ?? undefined
    await Bus.publish(TaskEvent.Killed, { id: taskId })
    return true
  }

  export function read(taskId: string): string | undefined {
    return state().get(taskId)?.output
  }

  export function tail(taskId: string, lines: number = 50): string | undefined {
    const output = state().get(taskId)?.output
    if (!output) return undefined
    const allLines = output.split("\n")
    return allLines.slice(-lines).join("\n")
  }

  export function remove(taskId: string): boolean {
    const task = state().get(taskId)
    if (!task || task.status === "running") return false
    state().delete(taskId)
    return true
  }
}
