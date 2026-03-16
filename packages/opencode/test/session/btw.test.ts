import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionStatus } from "../../src/session/status"
import { Todo } from "../../src/session/todo"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const model = {
  providerID: "openai",
  modelID: "gpt-5.2",
}

async function parts(sessionID: string) {
  const msgs = await Session.messages({ sessionID })
  return msgs.flatMap((msg) => msg.parts.filter((part) => part.type === "text").map((part) => part.text))
}

async function wait(check: () => Promise<boolean>) {
  for (let i = 0; i < 20; i++) {
    if (await check()) return
    await Bun.sleep(5)
  }
  throw new Error("timed out waiting for background result")
}

describe("session.prompt /btw", () => {
  test("appends todos immediately", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const result = await SessionPrompt.commandBtw({
          sessionID: session.id,
          agent: "build",
          model,
          arguments: "todo follow up on logs",
        })
        await SessionPrompt.commandBtw({
          sessionID: session.id,
          agent: "build",
          model,
          arguments: "todo file a note",
        })
        expect(result.info.role).toBe("assistant")
        const todos = await Todo.get(session.id)
        expect(todos.map((x) => x.content)).toEqual(["follow up on logs", "file a note"])
      },
    })
  })

  test("creates a child session for background and reports completion", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const result = await SessionPrompt.commandBtw({
          sessionID: session.id,
          agent: "build",
          model,
          arguments: "background what changed?",
          run: async (input) => ({
            info: {
              id: "msg_1",
              sessionID: input.sessionID,
              parentID: "msg_0",
              mode: input.agent ?? "build",
              agent: input.agent ?? "build",
              cost: 0,
              path: { cwd: Instance.directory, root: Instance.worktree },
              time: { created: Date.now(), completed: Date.now() },
              role: "assistant",
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: input.model?.modelID ?? model.modelID,
              providerID: input.model?.providerID ?? model.providerID,
            } satisfies MessageV2.Assistant,
            parts: [
              {
                id: "part_1",
                messageID: "msg_1",
                sessionID: input.sessionID,
                type: "text",
                text: "background answer",
              } satisfies MessageV2.TextPart,
            ],
          }),
        })
        expect(result.info.role).toBe("assistant")
        await wait(
          async () =>
            (await Session.children(session.id)).length === 1 &&
            (await parts(session.id)).some((x) => x.includes("background answer")),
        )
      },
    })
  })

  test("reports background child status", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        let done = false
        await SessionPrompt.commandBtw({
          sessionID: session.id,
          agent: "build",
          model,
          arguments: "background first",
          run: async (input) => {
            SessionStatus.set(input.sessionID, { type: "busy" })
            while (!done) await Bun.sleep(5)
            SessionStatus.set(input.sessionID, { type: "idle" })
            return {
              info: {
                id: "msg_2",
                sessionID: input.sessionID,
                parentID: "msg_0",
                mode: input.agent ?? "build",
                agent: input.agent ?? "build",
                cost: 0,
                path: { cwd: Instance.directory, root: Instance.worktree },
                time: { created: Date.now(), completed: Date.now() },
                role: "assistant",
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: input.model?.modelID ?? model.modelID,
                providerID: input.model?.providerID ?? model.providerID,
              } satisfies MessageV2.Assistant,
              parts: [
                {
                  id: "part_2",
                  messageID: "msg_2",
                  sessionID: input.sessionID,
                  type: "text",
                  text: "done later",
                } satisfies MessageV2.TextPart,
              ],
            }
          },
        })
        const result = await SessionPrompt.commandBtw({
          sessionID: session.id,
          agent: "build",
          model,
          arguments: "status",
        })
        const value = result.parts.find((part) => part.type === "text")
        expect(value?.text.includes("running")).toBe(true)
        done = true
      },
    })
  })
})
