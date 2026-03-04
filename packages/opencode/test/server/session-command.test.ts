import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("session.command endpoint", () => {
  test("rejects session IDs containing null bytes", async () => {
    await Instance.disposeAll()
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.App()
        const sessionID = `${session.id}\u0000bad`

        const response = await app.request(`/session/${encodeURIComponent(sessionID)}/command`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            command: "help",
            arguments: "",
          }),
        })

        expect(response.status).toBe(400)
      },
    })
  })
})
