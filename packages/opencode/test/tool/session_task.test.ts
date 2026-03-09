import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Todo } from "../../src/session/todo"
import { Bus } from "../../src/bus"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import crypto from "crypto"

Log.init({ print: false })

// Each test gets a unique session ID to prevent cross-test contamination
// since Storage uses a global XDG data directory
function uid() {
  return "s-" + crypto.randomBytes(8).toString("hex")
}

describe("Todo", () => {
  describe("createTask", () => {
    test("basic create", async () => {
      await using tmp = await tmpdir()
      const sid = uid()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const task = await Todo.createTask({
            sessionID: sid,
            id: "task-1",
            content: "Build the thing",
            priority: "high",
          })
          expect(task.id).toBe("task-1")
          expect(task.content).toBe("Build the thing")
          expect(task.priority).toBe("high")
          expect(task.status).toBe("pending")

          const list = await Todo.get(sid)
          expect(list.length).toBe(1)
          expect(list[0].id).toBe("task-1")
        },
      })
    })

    test("multiple creates append to list", async () => {
      await using tmp = await tmpdir()
      const sid = uid()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Todo.createTask({ sessionID: sid, id: "a", content: "first", priority: "high" })
          await Todo.createTask({ sessionID: sid, id: "b", content: "second", priority: "medium" })
          await Todo.createTask({ sessionID: sid, id: "c", content: "third", priority: "low" })

          const list = await Todo.get(sid)
          expect(list.length).toBe(3)
          expect(list[0].id).toBe("a")
          expect(list[1].id).toBe("b")
          expect(list[2].id).toBe("c")
        },
      })
    })

    test("auto-blocks when deps unresolved", async () => {
      await using tmp = await tmpdir()
      const sid = uid()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Todo.createTask({ sessionID: sid, id: "dep", content: "dependency task", priority: "high" })
          const task = await Todo.createTask({
            sessionID: sid,
            id: "child",
            content: "depends on dep",
            priority: "medium",
            depends_on: ["dep"],
          })
          expect(task.status).toBe("blocked")
        },
      })
    })

    test("pending when deps are completed", async () => {
      await using tmp = await tmpdir()
      const sid = uid()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Todo.createTask({ sessionID: sid, id: "dep", content: "dependency", priority: "high" })
          await Todo.updateTask({ sessionID: sid, id: "dep", status: "completed" })
          const task = await Todo.createTask({
            sessionID: sid,
            id: "child",
            content: "depends on completed dep",
            priority: "medium",
            depends_on: ["dep"],
          })
          expect(task.status).toBe("pending")
        },
      })
    })

    test("separate sessions are independent", async () => {
      await using tmp = await tmpdir()
      const sa = uid()
      const sb = uid()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Todo.createTask({ sessionID: sa, id: "task-1", content: "session a task", priority: "high" })
          await Todo.createTask({ sessionID: sb, id: "task-1", content: "session b task", priority: "low" })

          const a = await Todo.get(sa)
          const b = await Todo.get(sb)
          expect(a.length).toBe(1)
          expect(b.length).toBe(1)
          expect(a[0].content).toBe("session a task")
          expect(b[0].content).toBe("session b task")
        },
      })
    })
  })

  describe("updateTask", () => {
    test("status change", async () => {
      await using tmp = await tmpdir()
      const sid = uid()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Todo.createTask({ sessionID: sid, id: "task-1", content: "do stuff", priority: "high" })
          const updated = await Todo.updateTask({ sessionID: sid, id: "task-1", status: "in_progress" })
          expect(updated.status).toBe("in_progress")

          const list = await Todo.get(sid)
          expect(list[0].status).toBe("in_progress")
        },
      })
    })

    test("content change", async () => {
      await using tmp = await tmpdir()
      const sid = uid()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Todo.createTask({ sessionID: sid, id: "task-1", content: "original", priority: "high" })
          const updated = await Todo.updateTask({ sessionID: sid, id: "task-1", content: "revised" })
          expect(updated.content).toBe("revised")
        },
      })
    })

    test("priority change", async () => {
      await using tmp = await tmpdir()
      const sid = uid()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Todo.createTask({ sessionID: sid, id: "task-1", content: "task", priority: "high" })
          const updated = await Todo.updateTask({ sessionID: sid, id: "task-1", priority: "low" })
          expect(updated.priority).toBe("low")
        },
      })
    })

    test("depends_on change", async () => {
      await using tmp = await tmpdir()
      const sid = uid()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Todo.createTask({ sessionID: sid, id: "a", content: "first", priority: "high" })
          await Todo.createTask({ sessionID: sid, id: "b", content: "second", priority: "high" })
          const updated = await Todo.updateTask({ sessionID: sid, id: "b", depends_on: ["a"] })
          expect(updated.depends_on).toEqual(["a"])
          expect(updated.status).toBe("blocked")
        },
      })
    })

    test("throws on non-existent ID", async () => {
      await using tmp = await tmpdir()
      const sid = uid()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await expect(Todo.updateTask({ sessionID: sid, id: "ghost", status: "completed" })).rejects.toThrow(
            "Todo task not found: ghost",
          )
        },
      })
    })

    test("preserves other fields when updating one", async () => {
      await using tmp = await tmpdir()
      const sid = uid()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Todo.createTask({ sessionID: sid, id: "task-1", content: "original content", priority: "high" })
          const updated = await Todo.updateTask({ sessionID: sid, id: "task-1", status: "in_progress" })
          expect(updated.content).toBe("original content")
          expect(updated.priority).toBe("high")
          expect(updated.status).toBe("in_progress")
        },
      })
    })
  })

  describe("deleteTask", () => {
    test("basic delete", async () => {
      await using tmp = await tmpdir()
      const sid = uid()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Todo.createTask({ sessionID: sid, id: "task-1", content: "doomed", priority: "low" })
          const before = await Todo.get(sid)
          expect(before.length).toBe(1)

          await Todo.deleteTask({ sessionID: sid, id: "task-1" })

          const after = await Todo.get(sid)
          expect(after.length).toBe(0)
        },
      })
    })

    test("idempotent — no error on missing ID", async () => {
      await using tmp = await tmpdir()
      const sid = uid()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Todo.deleteTask({ sessionID: sid, id: "nonexistent" })
          const list = await Todo.get(sid)
          expect(list.length).toBe(0)
        },
      })
    })

    test("only removes specified task", async () => {
      await using tmp = await tmpdir()
      const sid = uid()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Todo.createTask({ sessionID: sid, id: "keep", content: "keep me", priority: "high" })
          await Todo.createTask({ sessionID: sid, id: "remove", content: "remove me", priority: "low" })

          await Todo.deleteTask({ sessionID: sid, id: "remove" })

          const list = await Todo.get(sid)
          expect(list.length).toBe(1)
          expect(list[0].id).toBe("keep")
        },
      })
    })

    test("cascading dep cleanup — unblocks dependents", async () => {
      await using tmp = await tmpdir()
      const sid = uid()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Todo.createTask({ sessionID: sid, id: "blocker", content: "I block things", priority: "high" })
          await Todo.createTask({
            sessionID: sid,
            id: "blocked",
            content: "I am blocked",
            priority: "medium",
            depends_on: ["blocker"],
          })

          const before = await Todo.get(sid)
          const pre = before.find((t) => t.id === "blocked")
          expect(pre!.status).toBe("blocked")

          await Todo.deleteTask({ sessionID: sid, id: "blocker" })

          const after = await Todo.get(sid)
          expect(after.length).toBe(1)
          const post = after.find((t) => t.id === "blocked")
          expect(post!.status).toBe("pending")
          expect(post!.depends_on).toBeUndefined()
        },
      })
    })
  })

  describe("dependency resolution", () => {
    test("blocked when dep is pending", async () => {
      await using tmp = await tmpdir()
      const sid = uid()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Todo.createTask({ sessionID: sid, id: "dep", content: "dependency", priority: "high" })
          const task = await Todo.createTask({
            sessionID: sid,
            id: "child",
            content: "child task",
            priority: "medium",
            depends_on: ["dep"],
          })
          expect(task.status).toBe("blocked")
        },
      })
    })

    test("unblocked when dep completes", async () => {
      await using tmp = await tmpdir()
      const sid = uid()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Todo.createTask({ sessionID: sid, id: "dep", content: "dependency", priority: "high" })
          await Todo.createTask({
            sessionID: sid,
            id: "child",
            content: "child task",
            priority: "medium",
            depends_on: ["dep"],
          })

          await Todo.updateTask({ sessionID: sid, id: "dep", status: "completed" })

          const list = await Todo.get(sid)
          const child = list.find((t) => t.id === "child")
          expect(child!.status).toBe("pending")
        },
      })
    })

    test("strips non-existent dep IDs", async () => {
      await using tmp = await tmpdir()
      const sid = uid()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const task = await Todo.createTask({
            sessionID: sid,
            id: "orphan",
            content: "references ghost",
            priority: "medium",
            depends_on: ["nonexistent"],
          })
          expect(task.status).toBe("pending")
          expect(task.depends_on).toBeUndefined()
        },
      })
    })

    test("strips some non-existent deps, keeps valid ones", async () => {
      await using tmp = await tmpdir()
      const sid = uid()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Todo.createTask({ sessionID: sid, id: "real", content: "real dep", priority: "high" })
          const task = await Todo.createTask({
            sessionID: sid,
            id: "mixed",
            content: "has mixed deps",
            priority: "medium",
            depends_on: ["real", "ghost"],
          })
          expect(task.depends_on).toEqual(["real"])
          expect(task.status).toBe("blocked")
        },
      })
    })

    test("circular deps warn but do not crash", async () => {
      await using tmp = await tmpdir()
      const sid = uid()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Todo.createTask({ sessionID: sid, id: "a", content: "task a", priority: "high" })
          await Todo.createTask({ sessionID: sid, id: "b", content: "task b", priority: "high", depends_on: ["a"] })

          // Create a cycle: a depends on b, b depends on a
          const updated = await Todo.updateTask({ sessionID: sid, id: "a", depends_on: ["b"] })
          const list = await Todo.get(sid)
          expect(list.length).toBe(2)
          expect(updated.depends_on).toEqual(["b"])
        },
      })
    })

    test("multi-level dependency chain", async () => {
      await using tmp = await tmpdir()
      const sid = uid()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Todo.createTask({ sessionID: sid, id: "root", content: "root task", priority: "high" })
          await Todo.createTask({
            sessionID: sid,
            id: "mid",
            content: "middle task",
            priority: "medium",
            depends_on: ["root"],
          })
          await Todo.createTask({
            sessionID: sid,
            id: "leaf",
            content: "leaf task",
            priority: "low",
            depends_on: ["mid"],
          })

          const list = await Todo.get(sid)
          expect(list.find((t) => t.id === "mid")!.status).toBe("blocked")
          expect(list.find((t) => t.id === "leaf")!.status).toBe("blocked")

          // Complete root — mid unblocks, leaf stays blocked
          await Todo.updateTask({ sessionID: sid, id: "root", status: "completed" })

          const after = await Todo.get(sid)
          expect(after.find((t) => t.id === "mid")!.status).toBe("pending")
          expect(after.find((t) => t.id === "leaf")!.status).toBe("blocked")
        },
      })
    })
  })

  describe("concurrency and locking", () => {
    test("parallel creates on same session don't lose data", async () => {
      await using tmp = await tmpdir()
      const sid = uid()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const count = 10
          const tasks = Array.from({ length: count }, (_, i) =>
            Todo.createTask({
              sessionID: sid,
              id: `task-${i}`,
              content: `task number ${i}`,
              priority: "medium",
            }),
          )

          await Promise.all(tasks)

          const list = await Todo.get(sid)
          expect(list.length).toBe(count)

          const ids = new Set(list.map((t) => t.id))
          for (let i = 0; i < count; i++) {
            expect(ids.has(`task-${i}`)).toBe(true)
          }
        },
      })
    })

    test("parallel operations on different sessions are independent", async () => {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const sessions = Array.from({ length: 5 }, () => uid())
          const ops = sessions.map((s) =>
            Todo.createTask({
              sessionID: s,
              id: "task-1",
              content: `task for ${s}`,
              priority: "high",
            }),
          )

          await Promise.all(ops)

          for (const s of sessions) {
            const list = await Todo.get(s)
            expect(list.length).toBe(1)
            expect(list[0].content).toBe(`task for ${s}`)
          }
        },
      })
    })

    test("parallel create and update on same session are serialized", async () => {
      await using tmp = await tmpdir()
      const sid = uid()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Todo.createTask({ sessionID: sid, id: "existing", content: "already here", priority: "high" })

          await Promise.all([
            Todo.createTask({ sessionID: sid, id: "new", content: "new task", priority: "low" }),
            Todo.updateTask({ sessionID: sid, id: "existing", status: "completed" }),
          ])

          const list = await Todo.get(sid)
          expect(list.length).toBe(2)
          const existing = list.find((t) => t.id === "existing")
          expect(existing!.status).toBe("completed")
        },
      })
    })
  })

  describe("get", () => {
    test("returns empty array for unknown session", async () => {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const list = await Todo.get(uid())
          expect(list).toEqual([])
        },
      })
    })
  })

  describe("update (bulk replace)", () => {
    test("replaces entire list", async () => {
      await using tmp = await tmpdir()
      const sid = uid()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Todo.createTask({ sessionID: sid, id: "old", content: "old task", priority: "low" })

          await Todo.update({
            sessionID: sid,
            todos: [
              { id: "new-1", content: "replacement 1", status: "pending", priority: "high" },
              { id: "new-2", content: "replacement 2", status: "in_progress", priority: "medium" },
            ],
          })

          const list = await Todo.get(sid)
          expect(list.length).toBe(2)
          expect(list[0].id).toBe("new-1")
          expect(list[1].id).toBe("new-2")
        },
      })
    })
  })

  describe("bus events", () => {
    test("createTask publishes event", async () => {
      await using tmp = await tmpdir()
      const sid = uid()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const events: any[] = []
          const unsub = Bus.subscribe(Todo.Event.Updated, (evt) => events.push(evt))

          await Todo.createTask({ sessionID: sid, id: "task-1", content: "test task", priority: "high" })

          expect(events.length).toBe(1)
          expect(events[0].properties.sessionID).toBe(sid)
          expect(events[0].properties.todos.length).toBe(1)
          expect(events[0].properties.todos[0].id).toBe("task-1")

          unsub()
        },
      })
    })

    test("updateTask publishes event", async () => {
      await using tmp = await tmpdir()
      const sid = uid()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Todo.createTask({ sessionID: sid, id: "task-1", content: "test", priority: "high" })

          const events: any[] = []
          const unsub = Bus.subscribe(Todo.Event.Updated, (evt) => events.push(evt))

          await Todo.updateTask({ sessionID: sid, id: "task-1", status: "completed" })

          expect(events.length).toBe(1)
          expect(events[0].properties.todos[0].status).toBe("completed")

          unsub()
        },
      })
    })

    test("deleteTask publishes event", async () => {
      await using tmp = await tmpdir()
      const sid = uid()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Todo.createTask({ sessionID: sid, id: "task-1", content: "test", priority: "high" })

          const events: any[] = []
          const unsub = Bus.subscribe(Todo.Event.Updated, (evt) => events.push(evt))

          await Todo.deleteTask({ sessionID: sid, id: "task-1" })

          expect(events.length).toBe(1)
          expect(events[0].properties.sessionID).toBe(sid)
          expect(events[0].properties.todos.length).toBe(0)

          unsub()
        },
      })
    })

    test("bulk update publishes event", async () => {
      await using tmp = await tmpdir()
      const sid = uid()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const events: any[] = []
          const unsub = Bus.subscribe(Todo.Event.Updated, (evt) => events.push(evt))

          await Todo.update({
            sessionID: sid,
            todos: [{ id: "x", content: "task x", status: "pending", priority: "high" }],
          })

          expect(events.length).toBe(1)
          expect(events[0].properties.todos.length).toBe(1)

          unsub()
        },
      })
    })
  })

  describe("systemContext", () => {
    test("returns empty for no tasks", async () => {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const result = await Todo.systemContext(uid(), [])
          expect(result).toEqual([])
        },
      })
    })

    test("returns empty when all tasks completed", async () => {
      await using tmp = await tmpdir()
      const sid = uid()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Todo.createTask({ sessionID: sid, id: "done", content: "finished task", priority: "high" })
          await Todo.updateTask({ sessionID: sid, id: "done", status: "completed" })

          const result = await Todo.systemContext(sid, [])
          expect(result).toEqual([])
        },
      })
    })

    test("returns empty when all tasks cancelled", async () => {
      await using tmp = await tmpdir()
      const sid = uid()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Todo.createTask({ sessionID: sid, id: "cancelled", content: "cancelled task", priority: "high" })
          await Todo.updateTask({ sessionID: sid, id: "cancelled", status: "cancelled" })

          const result = await Todo.systemContext(sid, [])
          expect(result).toEqual([])
        },
      })
    })

    test("includes restored message when no tool parts", async () => {
      await using tmp = await tmpdir()
      const sid = uid()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Todo.createTask({ sessionID: sid, id: "task-1", content: "pending task", priority: "high" })

          const messages: any[] = [
            {
              info: { id: "msg-1", sessionID: sid, role: "user" },
              parts: [{ type: "text", id: "p1", sessionID: sid, messageID: "msg-1", text: "hello" }],
            },
          ]

          const result = await Todo.systemContext(sid, messages)
          expect(result.length).toBe(1)
          expect(result[0]).toContain("restored from storage")
          expect(result[0]).toContain("session_task_update")
          expect(result[0]).toContain("task-1")
          expect(result[0]).toContain("pending task")
        },
      })
    })

    test("includes normal message when tool parts present", async () => {
      await using tmp = await tmpdir()
      const sid = uid()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Todo.createTask({ sessionID: sid, id: "task-1", content: "pending task", priority: "medium" })

          const messages: any[] = [
            {
              info: { id: "msg-1", sessionID: sid, role: "assistant" },
              parts: [
                {
                  type: "tool",
                  id: "p1",
                  sessionID: sid,
                  messageID: "msg-1",
                  callID: "c1",
                  tool: "session_task_create",
                  state: {
                    status: "completed",
                    input: {},
                    output: "",
                    title: "",
                    metadata: {},
                    time: { start: 0, end: 1 },
                  },
                },
              ],
            },
          ]

          const result = await Todo.systemContext(sid, messages)
          expect(result.length).toBe(1)
          expect(result[0]).toContain("Current task list:")
          expect(result[0]).not.toContain("restored from storage")
          expect(result[0]).toContain("task-1")
        },
      })
    })

    test("includes dependency info in markdown", async () => {
      await using tmp = await tmpdir()
      const sid = uid()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Todo.createTask({ sessionID: sid, id: "dep", content: "dependency", priority: "high" })
          await Todo.createTask({
            sessionID: sid,
            id: "child",
            content: "child task",
            priority: "medium",
            depends_on: ["dep"],
          })

          const result = await Todo.systemContext(sid, [])
          expect(result.length).toBe(1)
          expect(result[0]).toContain("depends on: dep")
        },
      })
    })

    test("formats priority as uppercase", async () => {
      await using tmp = await tmpdir()
      const sid = uid()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Todo.createTask({ sessionID: sid, id: "task-1", content: "high priority task", priority: "high" })

          const result = await Todo.systemContext(sid, [])
          expect(result[0]).toContain("HIGH:")
        },
      })
    })

    test("includes status in brackets", async () => {
      await using tmp = await tmpdir()
      const sid = uid()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Todo.createTask({ sessionID: sid, id: "task-1", content: "in progress task", priority: "medium" })
          await Todo.updateTask({ sessionID: sid, id: "task-1", status: "in_progress" })

          const result = await Todo.systemContext(sid, [])
          expect(result[0]).toContain("[in_progress]")
        },
      })
    })
  })
})
