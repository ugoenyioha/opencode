import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { Log } from "../../src/util/log"

const root = path.join(__dirname, "../..")
Log.init({ print: false })

describe("session.loop endpoint", () => {
  test("creates and stops loop jobs", async () => {
    await Instance.disposeAll()
    await Instance.provide({
      directory: root,
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})

        const create = await app.request(`/session/${session.id}/loop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            interval_ms: 60_000,
            prompt: "ping",
          }),
        })
        expect(create.status).toBe(200)

        const created = await create.json()
        expect(created.id).toContain("scr_")
        expect(created.interval_ms).toBe(60_000)
        expect(created.prompt).toBe("ping")

        const stop = await app.request(`/session/${session.id}/loop`, {
          method: "DELETE",
        })
        expect(stop.status).toBe(200)
        const stopped = await stop.json()
        expect(stopped.removed).toBe(1)

        const stopAgain = await app.request(`/session/${session.id}/loop`, {
          method: "DELETE",
        })
        expect(stopAgain.status).toBe(200)
        const stoppedAgain = await stopAgain.json()
        expect(stoppedAgain.removed).toBe(0)
      },
    })
  })

  test("validates loop schedule input", async () => {
    await Instance.disposeAll()
    await Instance.provide({
      directory: root,
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})

        const zero = await app.request(`/session/${session.id}/loop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            interval_ms: 0,
            prompt: "ping",
          }),
        })
        expect(zero.status).toBe(400)

        const tooSmall = await app.request(`/session/${session.id}/loop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            interval_ms: 59_000,
            prompt: "ping",
          }),
        })
        expect(tooSmall.status).toBe(400)

        const prompt = await app.request(`/session/${session.id}/loop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            interval_ms: 60_000,
            prompt: "",
          }),
        })
        expect(prompt.status).toBe(400)
      },
    })
  })

  test("stops all loop jobs for a session", async () => {
    await Instance.disposeAll()
    await Instance.provide({
      directory: root,
      fn: async () => {
        const app = Server.App()
        const session = await Session.create({})

        await app.request(`/session/${session.id}/loop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            interval_ms: 60_000,
            prompt: "one",
          }),
        })
        await app.request(`/session/${session.id}/loop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            interval_ms: 120_000,
            prompt: "two",
          }),
        })

        const stop = await app.request(`/session/${session.id}/loop`, {
          method: "DELETE",
        })
        expect(stop.status).toBe(200)
        const body = await stop.json()
        expect(body.removed).toBe(2)

        const stopAgain = await app.request(`/session/${session.id}/loop`, {
          method: "DELETE",
        })
        expect(stopAgain.status).toBe(200)
        const bodyAgain = await stopAgain.json()
        expect(bodyAgain.removed).toBe(0)
      },
    })
  })
})
