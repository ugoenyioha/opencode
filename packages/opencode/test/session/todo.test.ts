import { describe, expect, test } from "bun:test"
import { Todo } from "../../src/session/todo"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

describe("Todo.Info schema validation", () => {
  test("accepts valid status values", () => {
    for (const status of ["pending", "in_progress", "completed", "cancelled", "blocked"] as const) {
      const result = Todo.Info.safeParse({
        id: "1",
        content: "test",
        status,
        priority: "medium",
      })
      expect(result.success).toBe(true)
    }
  })

  test("rejects invalid status values", () => {
    const result = Todo.Info.safeParse({
      id: "1",
      content: "test",
      status: "build",
      priority: "medium",
    })
    expect(result.success).toBe(false)
  })

  test("rejects invalid priority values", () => {
    const result = Todo.Info.safeParse({
      id: "1",
      content: "test",
      status: "pending",
      priority: "urgent",
    })
    expect(result.success).toBe(false)
  })

  test("accepts valid priority values", () => {
    for (const priority of ["high", "medium", "low"] as const) {
      const result = Todo.Info.safeParse({
        id: "1",
        content: "test",
        status: "pending",
        priority,
      })
      expect(result.success).toBe(true)
    }
  })

  test("accepts todo without depends_on", () => {
    const result = Todo.Info.safeParse({
      id: "1",
      content: "test",
      status: "pending",
      priority: "medium",
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.depends_on).toBeUndefined()
    }
  })

  test("accepts todo with depends_on array", () => {
    const result = Todo.Info.safeParse({
      id: "2",
      content: "depends on 1",
      status: "pending",
      priority: "medium",
      depends_on: ["1"],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.depends_on).toEqual(["1"])
    }
  })
})

describe("Todo.update dependency resolution", () => {
  test("auto-blocks task with incomplete dependencies", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Todo.update({
          sessionID: "test-session-1",
          todos: [
            { id: "1", content: "first", status: "pending", priority: "high" },
            { id: "2", content: "second", status: "pending", priority: "high", depends_on: ["1"] },
          ],
        })

        const todos = await Todo.get("test-session-1")
        const task2 = todos.find((t) => t.id === "2")
        expect(task2?.status).toBe("blocked")
      },
    })
  })

  test("auto-unblocks task when dependencies are completed", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Todo.update({
          sessionID: "test-session-2",
          todos: [
            { id: "1", content: "first", status: "completed", priority: "high" },
            { id: "2", content: "second", status: "blocked", priority: "high", depends_on: ["1"] },
          ],
        })

        const todos = await Todo.get("test-session-2")
        const task2 = todos.find((t) => t.id === "2")
        expect(task2?.status).toBe("pending")
      },
    })
  })

  test("task with no deps stays in its current status", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Todo.update({
          sessionID: "test-session-3",
          todos: [
            { id: "1", content: "no deps", status: "in_progress", priority: "high" },
          ],
        })

        const todos = await Todo.get("test-session-3")
        expect(todos[0].status).toBe("in_progress")
      },
    })
  })

  test("strips references to non-existent dependency IDs", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Todo.update({
          sessionID: "test-session-4",
          todos: [
            { id: "1", content: "exists", status: "pending", priority: "high" },
            { id: "2", content: "has bad dep", status: "pending", priority: "high", depends_on: ["1", "nonexistent"] },
          ],
        })

        const todos = await Todo.get("test-session-4")
        const task2 = todos.find((t) => t.id === "2")
        expect(task2?.depends_on).toEqual(["1"])
        // Since dep "1" is still pending, task2 should be blocked
        expect(task2?.status).toBe("blocked")
      },
    })
  })

  test("strips depends_on entirely when all references are invalid", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Todo.update({
          sessionID: "test-session-5",
          todos: [
            { id: "1", content: "has only bad deps", status: "pending", priority: "high", depends_on: ["gone1", "gone2"] },
          ],
        })

        const todos = await Todo.get("test-session-5")
        expect(todos[0].depends_on).toBeUndefined()
        expect(todos[0].status).toBe("pending")
      },
    })
  })

  test("does not auto-block completed or cancelled tasks", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Todo.update({
          sessionID: "test-session-6",
          todos: [
            { id: "1", content: "incomplete dep", status: "pending", priority: "high" },
            { id: "2", content: "already done", status: "completed", priority: "high", depends_on: ["1"] },
            { id: "3", content: "already cancelled", status: "cancelled", priority: "low", depends_on: ["1"] },
          ],
        })

        const todos = await Todo.get("test-session-6")
        expect(todos.find((t) => t.id === "2")?.status).toBe("completed")
        expect(todos.find((t) => t.id === "3")?.status).toBe("cancelled")
      },
    })
  })

  test("handles chain of dependencies", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Todo.update({
          sessionID: "test-session-7",
          todos: [
            { id: "1", content: "first", status: "pending", priority: "high" },
            { id: "2", content: "second", status: "pending", priority: "high", depends_on: ["1"] },
            { id: "3", content: "third", status: "pending", priority: "high", depends_on: ["2"] },
          ],
        })

        const todos = await Todo.get("test-session-7")
        expect(todos.find((t) => t.id === "1")?.status).toBe("pending")
        expect(todos.find((t) => t.id === "2")?.status).toBe("blocked")
        expect(todos.find((t) => t.id === "3")?.status).toBe("blocked")
      },
    })
  })

  test("handles multiple dependencies (AND logic)", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Both deps completed → unblocked
        await Todo.update({
          sessionID: "test-session-8a",
          todos: [
            { id: "1", content: "dep A", status: "completed", priority: "high" },
            { id: "2", content: "dep B", status: "completed", priority: "high" },
            { id: "3", content: "needs both", status: "blocked", priority: "high", depends_on: ["1", "2"] },
          ],
        })
        let todos = await Todo.get("test-session-8a")
        expect(todos.find((t) => t.id === "3")?.status).toBe("pending")

        // Only one dep completed → still blocked
        await Todo.update({
          sessionID: "test-session-8b",
          todos: [
            { id: "1", content: "dep A", status: "completed", priority: "high" },
            { id: "2", content: "dep B", status: "pending", priority: "high" },
            { id: "3", content: "needs both", status: "pending", priority: "high", depends_on: ["1", "2"] },
          ],
        })
        todos = await Todo.get("test-session-8b")
        expect(todos.find((t) => t.id === "3")?.status).toBe("blocked")
      },
    })
  })
})

describe("Todo compaction survival", () => {
  test("incomplete todos are retrievable for compaction injection", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Simulate a session with mixed-status todos
        await Todo.update({
          sessionID: "compact-test-1",
          todos: [
            { id: "done", content: "already finished", status: "completed", priority: "high" },
            { id: "cancelled", content: "no longer needed", status: "cancelled", priority: "low" },
            { id: "active", content: "currently working on this", status: "in_progress", priority: "high" },
            { id: "next", content: "do this next", status: "pending", priority: "medium", depends_on: ["active"] },
            { id: "blocked-task", content: "waiting on next", status: "pending", priority: "low", depends_on: ["next"] },
          ],
        })

        // This is what compaction.ts does: get todos, filter incomplete
        const todos = await Todo.get("compact-test-1")
        const incomplete = todos.filter((t) => t.status !== "completed" && t.status !== "cancelled")

        // Should have 3 incomplete todos (in_progress, blocked, blocked)
        expect(incomplete.length).toBe(3)

        // Verify the serialized output contains the data the LLM needs
        const serialized = JSON.stringify(incomplete, null, 2)
        expect(serialized).toContain("currently working on this")
        expect(serialized).toContain("do this next")
        expect(serialized).toContain("waiting on next")
        expect(serialized).toContain("depends_on")
        expect(serialized).toContain('"active"') // dep reference preserved

        // Should NOT contain completed/cancelled
        expect(serialized).not.toContain("already finished")
        expect(serialized).not.toContain("no longer needed")
      },
    })
  })

  test("empty todo list produces no compaction context", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const todos = await Todo.get("nonexistent-session")
        expect(todos.length).toBe(0)
      },
    })
  })

  test("all-completed todo list produces no incomplete todos", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Todo.update({
          sessionID: "compact-test-2",
          todos: [
            { id: "1", content: "done1", status: "completed", priority: "high" },
            { id: "2", content: "done2", status: "completed", priority: "medium" },
          ],
        })

        const todos = await Todo.get("compact-test-2")
        const incomplete = todos.filter((t) => t.status !== "completed" && t.status !== "cancelled")
        expect(incomplete.length).toBe(0)
      },
    })
  })
})
