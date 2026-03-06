import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { LSPServer } from "../../src/lsp/server"
import { Archive } from "../../src/util/archive"
import { Global } from "../../src/global"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"

const resetHardened = () => {
  delete process.env.OPENCODE_HARDENED_MODE
}

describe("LSP security", () => {
  const originalWhich = Bun.which
  const originalFetch = globalThis.fetch

  afterEach(() => {
    Bun.which = originalWhich
    globalThis.fetch = originalFetch
    resetHardened()
  })

  test("biome prefers workspace bin when not hardened", async () => {
    await using tmp = await tmpdir({ git: true })
    const localBin = path.join(tmp.path, "node_modules", ".bin", "biome")
    await fs.mkdir(path.dirname(localBin), { recursive: true })
    await fs.writeFile(localBin, "#!/bin/sh\necho biome\n")

    const child = await import("child_process")
    const spawnSpy = spyOn(child, "spawn").mockImplementation(
      () => ({ stdout: { on: () => {} }, stderr: { on: () => {} }, on: () => {}, once: () => {}, pid: 123 }) as any,
    )

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const handle = await LSPServer.Biome.spawn(tmp.path)
        expect(handle).toBeDefined()
        expect(spawnSpy).toHaveBeenCalled()
        expect(spawnSpy.mock.calls.some((call) => call[0] === localBin)).toBe(true)
      },
    })

    spawnSpy.mockRestore()
  })

  test("biome blocks workspace bin in hardened mode", async () => {
    process.env.OPENCODE_HARDENED_MODE = "true"

    await using tmp = await tmpdir({ git: true })
    const localBin = path.join(tmp.path, "node_modules", ".bin", "biome")
    await fs.mkdir(path.dirname(localBin), { recursive: true })
    await fs.writeFile(localBin, "#!/bin/sh\necho biome\n")

    Bun.which = (name: string) => (name === "biome" ? "/usr/bin/biome" : originalWhich(name))

    const child = await import("child_process")
    const spawnSpy = spyOn(child, "spawn").mockImplementation(
      () => ({ stdout: { on: () => {} }, stderr: { on: () => {} }, on: () => {}, once: () => {}, pid: 123 }) as any,
    )

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const handle = await LSPServer.Biome.spawn(tmp.path)
        expect(handle).toBeDefined()
        expect(spawnSpy.mock.calls.some((call) => call[0] === "/usr/bin/biome")).toBe(true)
        expect(spawnSpy.mock.calls.some((call) => call[0] === localBin)).toBe(false)
      },
    })

    spawnSpy.mockRestore()
  })

  test("oxlint prefers workspace bin when not hardened", async () => {
    await using tmp = await tmpdir({ git: true })
    const serverBin = path.join(tmp.path, "node_modules", ".bin", "oxc_language_server")
    await fs.mkdir(path.dirname(serverBin), { recursive: true })
    await fs.writeFile(serverBin, "#!/bin/sh\necho server\n")

    const child = await import("child_process")
    const spawnSpy = spyOn(child, "spawn").mockImplementation(
      () => ({ stdout: { on: () => {} }, stderr: { on: () => {} }, on: () => {}, once: () => {}, pid: 123 }) as any,
    )

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const handle = await LSPServer.Oxlint.spawn(tmp.path)
        expect(handle).toBeDefined()
        expect(spawnSpy.mock.calls.some((call) => call[0] === serverBin)).toBe(true)
      },
    })

    spawnSpy.mockRestore()
  })

  test("oxlint blocks workspace bin in hardened mode", async () => {
    process.env.OPENCODE_HARDENED_MODE = "true"

    await using tmp = await tmpdir({ git: true })
    const serverBin = path.join(tmp.path, "node_modules", ".bin", "oxc_language_server")
    await fs.mkdir(path.dirname(serverBin), { recursive: true })
    await fs.writeFile(serverBin, "#!/bin/sh\necho server\n")

    Bun.which = (name: string) =>
      name === "oxc_language_server" ? "/usr/bin/oxc_language_server" : originalWhich(name)

    const child = await import("child_process")
    const spawnSpy = spyOn(child, "spawn").mockImplementation(
      () => ({ stdout: { on: () => {} }, stderr: { on: () => {} }, on: () => {}, once: () => {}, pid: 123 }) as any,
    )

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const handle = await LSPServer.Oxlint.spawn(tmp.path)
        expect(handle).toBeDefined()
        expect(spawnSpy.mock.calls.some((call) => call[0] === "/usr/bin/oxc_language_server")).toBe(true)
        expect(spawnSpy.mock.calls.some((call) => call[0] === serverBin)).toBe(false)
      },
    })

    spawnSpy.mockRestore()
  })

  test("terraform-ls download requires checksum", async () => {
    const platform = process.platform
    const arch = process.arch
    const tfArch = arch === "arm64" ? "arm64" : "amd64"
    const tfPlatform = platform === "win32" ? "windows" : platform
    const version = "1.2.3"
    const assetName = `terraform-ls_${version}_${tfPlatform}_${tfArch}.zip`
    const downloadUrl = `https://example.com/${assetName}`
    const checksumUrl = `https://releases.hashicorp.com/terraform-ls/${version}/terraform-ls_${version}_SHA256SUMS`

    globalThis.fetch = mock((url: string | URL | Request) => {
      const urlStr = url.toString()
      if (urlStr.includes("api.releases.hashicorp.com/v1/releases/terraform-ls/latest")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              version,
              builds: [
                {
                  arch: tfArch,
                  os: tfPlatform,
                  url: downloadUrl,
                },
              ],
            }),
            { status: 200 },
          ),
        )
      }
      if (urlStr === downloadUrl) {
        return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
      }
      if (urlStr === checksumUrl) {
        return Promise.resolve(new Response("", { status: 404 }))
      }
      return Promise.resolve(new Response("", { status: 404 }))
    }) as unknown as typeof fetch

    const extractSpy = spyOn(Archive, "extractZip").mockImplementation(async () => {
      const bin = path.join(Global.Path.bin, "terraform-ls" + (platform === "win32" ? ".exe" : ""))
      await fs.mkdir(Global.Path.bin, { recursive: true })
      await fs.writeFile(bin, "binary")
      return
    })

    await Instance.provide({
      directory: Global.Path.bin,
      fn: async () => {
        const handle = await LSPServer.TerraformLS.spawn(Global.Path.bin)
        expect(handle).toBeUndefined()
        expect(extractSpy).not.toHaveBeenCalled()
      },
    })

    extractSpy.mockRestore()
  })
})
