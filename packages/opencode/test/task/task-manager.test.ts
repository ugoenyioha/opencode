import { describe, expect, test } from "bun:test"
import { spawn } from "child_process"
import { TaskManager } from "../../src/task"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

async function cleanup() {
  for (const task of TaskManager.list()) {
    if (task.status === "running") {
      await TaskManager.kill(task.id)
      await Bun.sleep(100)
    }
    TaskManager.remove(task.id)
  }
}

describe("TaskManager", () => {

  test("adopt registers a running process as a background task", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const proc = spawn("sleep", ["10"], { stdio: "pipe" })
        const task = await TaskManager.adopt({
          process: proc,
          command: "sleep 10",
          workdir: tmp.path,
          description: "Test sleep",
          initialOutput: "",
          startTime: Date.now(),
        })

        expect(task.id).toStartWith("task_")
        expect(task.pid).toBe(proc.pid!)
        expect(task.command).toBe("sleep 10")
        expect(task.status).toBe("running")
        expect(task.description).toBe("Test sleep")

        // Cleanup
        await TaskManager.kill(task.id)
      },
    })
  })

  test("list returns all tasks", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const proc1 = spawn("sleep", ["10"], { stdio: "pipe" })
        const proc2 = spawn("sleep", ["10"], { stdio: "pipe" })

        await TaskManager.adopt({
          process: proc1,
          command: "sleep 10",
          workdir: tmp.path,
          description: "Task 1",
          initialOutput: "",
          startTime: Date.now(),
        })
        await TaskManager.adopt({
          process: proc2,
          command: "sleep 10",
          workdir: tmp.path,
          description: "Task 2",
          initialOutput: "",
          startTime: Date.now(),
        })

        const tasks = TaskManager.list()
        expect(tasks.length).toBe(2)
        expect(tasks.map((t) => t.description).sort()).toEqual(["Task 1", "Task 2"])

        // Cleanup
        for (const t of tasks) await TaskManager.kill(t.id)
      },
    })
  })

  test("get returns a task by ID", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const proc = spawn("sleep", ["10"], { stdio: "pipe" })
        const task = await TaskManager.adopt({
          process: proc,
          command: "sleep 10",
          workdir: tmp.path,
          description: "Get test",
          initialOutput: "",
          startTime: Date.now(),
        })

        const found = TaskManager.get(task.id)
        expect(found).toBeDefined()
        expect(found!.id).toBe(task.id)
        expect(found!.status).toBe("running")

        expect(TaskManager.get("nonexistent")).toBeUndefined()

        await TaskManager.kill(task.id)
      },
    })
  })

  test("kill terminates a running task", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const proc = spawn("sleep", ["60"], { stdio: "pipe", detached: true })
        const task = await TaskManager.adopt({
          process: proc,
          command: "sleep 60",
          workdir: tmp.path,
          description: "Kill test",
          initialOutput: "",
          startTime: Date.now(),
        })

        const killed = await TaskManager.kill(task.id)
        expect(killed).toBe(true)

        // Wait for process exit event
        await Bun.sleep(300)

        const updated = TaskManager.get(task.id)
        expect(updated!.status).toBe("failed")
      },
    })
  })

  test("kill returns false for nonexistent or completed task", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await TaskManager.kill("nonexistent")
        expect(result).toBe(false)
      },
    })
  })

  test("read returns captured output", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const proc = spawn("echo", ["hello background"], { stdio: "pipe" })
        const task = await TaskManager.adopt({
          process: proc,
          command: "echo hello background",
          workdir: tmp.path,
          description: "Output test",
          initialOutput: "initial > ",
          startTime: Date.now(),
        })

        // Wait for process to finish and output to be captured
        await Bun.sleep(500)

        const output = TaskManager.read(task.id)
        expect(output).toBeDefined()
        expect(output).toContain("initial > ")
        expect(output).toContain("hello background")
      },
    })
  })

  test("read returns undefined for nonexistent task", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(TaskManager.read("nonexistent")).toBeUndefined()
      },
    })
  })

  test("tail returns last N lines", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const proc = spawn("bash", ["-c", "for i in 1 2 3 4 5; do echo line$i; done"], { stdio: "pipe" })
        const task = await TaskManager.adopt({
          process: proc,
          command: "print lines",
          workdir: tmp.path,
          description: "Tail test",
          initialOutput: "",
          startTime: Date.now(),
        })

        await Bun.sleep(500)

        const last2 = TaskManager.tail(task.id, 2)
        expect(last2).toBeDefined()
        // Last line is empty after final newline, so last 2 meaningful lines
        const lines = last2!.split("\n").filter((l) => l.length > 0)
        expect(lines).toContain("line5")
      },
    })
  })

  test("remove deletes a completed task", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const proc = spawn("echo", ["done"], { stdio: "pipe" })
        const task = await TaskManager.adopt({
          process: proc,
          command: "echo done",
          workdir: tmp.path,
          description: "Remove test",
          initialOutput: "",
          startTime: Date.now(),
        })

        await Bun.sleep(500)

        const removed = TaskManager.remove(task.id)
        expect(removed).toBe(true)
        expect(TaskManager.get(task.id)).toBeUndefined()
        expect(TaskManager.list().length).toBe(0)
      },
    })
  })

  test("remove fails for running task", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const proc = spawn("sleep", ["60"], { stdio: "pipe" })
        const task = await TaskManager.adopt({
          process: proc,
          command: "sleep 60",
          workdir: tmp.path,
          description: "Remove running test",
          initialOutput: "",
          startTime: Date.now(),
        })

        const removed = TaskManager.remove(task.id)
        expect(removed).toBe(false)
        expect(TaskManager.get(task.id)).toBeDefined()

        await TaskManager.kill(task.id)
      },
    })
  })

  test("task status updates to completed on exit code 0", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const proc = spawn("true", [], { stdio: "pipe" })
        const task = await TaskManager.adopt({
          process: proc,
          command: "true",
          workdir: tmp.path,
          description: "Exit 0",
          initialOutput: "",
          startTime: Date.now(),
        })

        await Bun.sleep(300)

        const updated = TaskManager.get(task.id)
        expect(updated!.status).toBe("completed")
        expect(updated!.exitCode).toBe(0)
      },
    })
  })

  test("task status updates to failed on nonzero exit", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const proc = spawn("false", [], { stdio: "pipe" })
        const task = await TaskManager.adopt({
          process: proc,
          command: "false",
          workdir: tmp.path,
          description: "Exit 1",
          initialOutput: "",
          startTime: Date.now(),
        })

        await Bun.sleep(300)

        const updated = TaskManager.get(task.id)
        expect(updated!.status).toBe("failed")
        expect(updated!.exitCode).toBe(1)
      },
    })
  })

  test("initial output is preserved", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const proc = spawn("true", [], { stdio: "pipe" })
        const task = await TaskManager.adopt({
          process: proc,
          command: "true",
          workdir: tmp.path,
          description: "Initial output",
          initialOutput: "captured before migration\n",
          startTime: Date.now(),
        })

        await Bun.sleep(300)

        const output = TaskManager.read(task.id)
        expect(output).toStartWith("captured before migration\n")
      },
    })
  })
})
