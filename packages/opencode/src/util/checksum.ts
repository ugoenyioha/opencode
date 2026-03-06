import { createHash } from "crypto"

export namespace Checksum {
  export async function sha256(path: string) {
    const buf = await Bun.file(path).arrayBuffer()
    return createHash("sha256").update(new Uint8Array(buf)).digest("hex")
  }

  export function parse(text: string, filename?: string) {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    if (lines.length === 0) return

    if (filename) {
      const match = lines.find((line) => line.includes(filename))
      if (match) {
        const token = match.split(/\s+/)[0]
        if (token) return token
      }
    }

    const token = lines[0].split(/\s+/)[0]
    return token || undefined
  }

  export async function fetch(url: string, filename?: string): Promise<string | undefined> {
    const response = await globalThis.fetch(url)
    if (!response.ok) return
    const text = await response.text()
    return parse(text, filename)
  }

  export async function verify(path: string, expected: string) {
    const actual = await sha256(path)
    if (actual !== expected) {
      throw new Error(`SHA256 mismatch: expected ${expected}, got ${actual}`)
    }
  }
}
