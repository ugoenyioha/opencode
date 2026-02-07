import { describe, expect, test } from "bun:test"
import { spawn } from "child_process"
import { ProcessQueryTool } from "../../src/tool/process-query"
import { TaskManager } from "../../src/task"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

describe("tool.process_query", () => {

  test("list action with no tasks", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await ProcessQueryTool.init()
        const result = await tool.execute({ action: "list" }, ctx)
        expect(result.output).toBe("No background tasks.")
      },
    })
  })

  test("list action shows tasks", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const proc = spawn("sleep", ["60"], { stdio: "pipe" })
        await TaskManager.adopt({
          process: proc,
          command: "sleep 60",
          workdir: tmp.path,
          description: "Long sleep",
          initialOutput: "",
          startTime: Date.now(),
        })

        const tool = await ProcessQueryTool.init()
        const result = await tool.execute({ action: "list" }, ctx)
        expect(result.output).toContain("1 background task(s)")
        expect(result.output).toContain("Long sleep")
        expect(result.output).toContain("running")

        for (const t of TaskManager.list()) await TaskManager.kill(t.id)
      },
    })
  })

  test("status action returns task info", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const proc = spawn("sleep", ["60"], { stdio: "pipe" })
        const task = await TaskManager.adopt({
          process: proc,
          command: "sleep 60",
          workdir: tmp.path,
          description: "Status test",
          initialOutput: "",
          startTime: Date.now(),
        })

        const tool = await ProcessQueryTool.init()
        const result = await tool.execute({ action: "status", identifier: task.id }, ctx)
        expect(result.output).toContain(`Task ID: ${task.id}`)
        expect(result.output).toContain("Status: running")
        expect(result.output).toContain("Command: sleep 60")
        expect(result.output).toContain("Description: Status test")

        await TaskManager.kill(task.id)
      },
    })
  })

  test("status action with 'last' identifier", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const proc1 = spawn("sleep", ["60"], { stdio: "pipe" })
        await TaskManager.adopt({
          process: proc1,
          command: "sleep 60",
          workdir: tmp.path,
          description: "First",
          initialOutput: "",
          startTime: Date.now() - 5000,
        })

        const proc2 = spawn("sleep", ["60"], { stdio: "pipe" })
        const task2 = await TaskManager.adopt({
          process: proc2,
          command: "sleep 60",
          workdir: tmp.path,
          description: "Second",
          initialOutput: "",
          startTime: Date.now(),
        })

        const tool = await ProcessQueryTool.init()
        const result = await tool.execute({ action: "status", identifier: "last" }, ctx)
        expect(result.output).toContain(`Task ID: ${task2.id}`)
        expect(result.output).toContain("Description: Second")

        for (const t of TaskManager.list()) await TaskManager.kill(t.id)
      },
    })
  })

  test("read_output returns full output", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const proc = spawn("echo", ["hello from background"], { stdio: "pipe" })
        const task = await TaskManager.adopt({
          process: proc,
          command: "echo hello",
          workdir: tmp.path,
          description: "Read test",
          initialOutput: "",
          startTime: Date.now(),
        })

        await Bun.sleep(300)

        const tool = await ProcessQueryTool.init()
        const result = await tool.execute({ action: "read_output", identifier: task.id }, ctx)
        expect(result.output).toContain("hello from background")
      },
    })
  })

  test("read_last_n returns tail lines", async () => {
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

        await Bun.sleep(300)

        const tool = await ProcessQueryTool.init()
        const result = await tool.execute({ action: "read_last_n", identifier: task.id, lines: 3 }, ctx)
        expect(result.output).toContain("line5")
      },
    })
  })

  test("search finds matching lines", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const proc = spawn("bash", ["-c", "echo 'ERROR: something failed'; echo 'OK: all good'; echo 'ERROR: another'"], {
          stdio: "pipe",
        })
        const task = await TaskManager.adopt({
          process: proc,
          command: "print errors",
          workdir: tmp.path,
          description: "Search test",
          initialOutput: "",
          startTime: Date.now(),
        })

        await Bun.sleep(300)

        const tool = await ProcessQueryTool.init()
        const result = await tool.execute({ action: "search", identifier: task.id, pattern: "ERROR" }, ctx)
        expect(result.output).toContain("2 match(es)")
        expect(result.output).toContain("ERROR: something failed")
        expect(result.output).toContain("ERROR: another")
      },
    })
  })

  test("search with no matches", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const proc = spawn("echo", ["all good"], { stdio: "pipe" })
        const task = await TaskManager.adopt({
          process: proc,
          command: "echo",
          workdir: tmp.path,
          description: "No match test",
          initialOutput: "",
          startTime: Date.now(),
        })

        await Bun.sleep(300)

        const tool = await ProcessQueryTool.init()
        const result = await tool.execute({ action: "search", identifier: task.id, pattern: "FATAL" }, ctx)
        expect(result.output).toContain("No matches")
      },
    })
  })

  test("error when identifier missing", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await ProcessQueryTool.init()
        const result = await tool.execute({ action: "status" }, ctx)
        expect(result.output).toContain("identifier required")
      },
    })
  })

  test("error when task not found", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await ProcessQueryTool.init()
        const result = await tool.execute({ action: "status", identifier: "nonexistent" }, ctx)
        expect(result.output).toContain("No task matching")
      },
    })
  })

  test("resolves by partial description match", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const proc = spawn("sleep", ["60"], { stdio: "pipe" })
        const task = await TaskManager.adopt({
          process: proc,
          command: "sleep 60",
          workdir: tmp.path,
          description: "Running npm test suite",
          initialOutput: "",
          startTime: Date.now(),
        })

        const tool = await ProcessQueryTool.init()
        const result = await tool.execute({ action: "status", identifier: "npm test" }, ctx)
        expect(result.output).toContain(`Task ID: ${task.id}`)

        await TaskManager.kill(task.id)
      },
    })
  })
})
