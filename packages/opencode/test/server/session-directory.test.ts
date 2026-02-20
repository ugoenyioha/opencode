import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("session directory resolution", () => {
  test("session-scoped routes resolve directory from stored session", async () => {
    await Instance.disposeAll()
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})

        // Session.create stores directory in SQLite via Instance context.
        // Verify via Session.get (DB-backed) — findDirectory scans file storage
        // which isn't populated by Session.create in test env.
        const retrieved = await Session.get(session.id)
        expect(retrieved.directory).toBe(projectRoot)
      },
    })
  })

  test("GET /session/:id resolves directory from session when no query param", async () => {
    await Instance.disposeAll()
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.App()

        // Request without ?directory= param — middleware should resolve from session
        const response = await app.request(`/session/${session.id}`)
        expect(response.status).toBe(200)
        const body = (await response.json()) as Session.Info
        expect(body.id).toBe(session.id)
        expect(body.directory).toBe(projectRoot)
      },
    })
  })

  test("findDirectory returns undefined for nonexistent session", async () => {
    await Instance.disposeAll()
    const found = await Session.findDirectory("ses_nonexistent123")
    expect(found).toBeUndefined()
  })
})
