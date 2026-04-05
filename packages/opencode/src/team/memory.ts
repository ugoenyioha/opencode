/**
 * Team Memory — shared knowledge store for agent teams.
 *
 * Persists facts to ~/.local/share/opencode/team-memory/<projectID>/
 * so all teammates in a team (and across restarts) can read shared context.
 *
 * Security:
 *   - Secret scanner rejects content containing credentials/tokens
 *   - Keys are sanitized to safe filenames (alphanumeric + hyphens)
 *   - Per-file size limit (8 KB) and total dir size limit (512 KB)
 *   - Content validated via sanitizeForStorage before write
 */

import path from "path"
import fs from "fs/promises"
import { Global } from "../global"
import { Instance } from "../project/instance"
import { sanitizeForStorage, stripInvisibleUnicode } from "../util/input-sanitization"
import { Log } from "../util/log"

const log = Log.create({ service: "team.memory" })

/** Max size per memory file (bytes) */
const FILE_SIZE_LIMIT = 8 * 1024

/** Max total size for all memory files in the project dir (bytes) */
const DIR_SIZE_LIMIT = 512 * 1024

// ---------------------------------------------------------------------------
// Secret scanner — rejects content containing likely credentials
// Patterns sourced from gitleaks default ruleset
// ---------------------------------------------------------------------------
const SECRET_PATTERNS: RegExp[] = [
  // AWS
  /(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/,
  /(?:aws|AWS)[\s_-]?(?:secret|SECRET)[\s_-]?(?:access|ACCESS)?[\s_-]?(?:key|KEY)[\s'"=:]+[A-Za-z0-9/+=]{40}/,
  // GitHub
  /gh[pousr]_[A-Za-z0-9]{36,255}/,
  /github_pat_[A-Za-z0-9_]{82}/,
  // Generic API key patterns
  /\bsk-[A-Za-z0-9]{32,64}\b/, // OpenAI, Anthropic style
  /\bxoxb-[0-9A-Za-z-]{24,}/,  // Slack bot token
  /\bxoxp-[0-9A-Za-z-]{24,}/,  // Slack user token
  // Private keys
  /-----BEGIN\s+(?:RSA|EC|DSA|OPENSSH|PGP)\s+PRIVATE KEY/,
  // Generic high-entropy secrets (hex 40+, base64 60+)
  /\b[0-9a-f]{40,}\b/,
  /[A-Za-z0-9+/]{60,}={0,2}/,
]

function containsSecret(content: string): string | null {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(content)) return pattern.toString()
  }
  return null
}

function memoryDir(): string {
  return path.join(Global.Path.data, "team-memory", Instance.project.id)
}

function safeKey(key: string): string {
  // Sanitize to alphanumeric + hyphens, max 64 chars
  return key
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || "default"
}

async function totalDirSize(dir: string): Promise<number> {
  const entries = await fs.readdir(dir).catch(() => [] as string[])
  let total = 0
  for (const entry of entries) {
    const stat = await fs.stat(path.join(dir, entry)).catch(() => null)
    if (stat?.isFile()) total += stat.size
  }
  return total
}

export namespace TeamMemory {
  /**
   * Write a fact to the shared team memory store.
   * Returns the path written or throws on validation failure.
   */
  export async function write(key: string, content: string): Promise<string> {
    // Sanitize content
    const stripped = stripInvisibleUnicode(content)
    const validation = sanitizeForStorage(stripped)
    if (!validation.valid) throw new Error(`team_memory_write: ${validation.reason}`)

    // Size check on content (before secret scan to avoid false positives from padding)
    const encoded = Buffer.byteLength(validation.sanitized, "utf8")
    if (encoded > FILE_SIZE_LIMIT) throw new Error(`team_memory_write: content too large (${encoded} bytes, max ${FILE_SIZE_LIMIT})`)

    // Secret scan
    const secretMatch = containsSecret(validation.sanitized)
    if (secretMatch) throw new Error(`team_memory_write: content appears to contain a secret (matched: ${secretMatch.slice(0, 40)}). Refused to store.`)

    const dir = memoryDir()
    await fs.mkdir(dir, { recursive: true })

    // Total dir size check
    const dirSize = await totalDirSize(dir)
    if (dirSize + encoded > DIR_SIZE_LIMIT) throw new Error(`team_memory_write: team memory directory full (${dirSize} bytes used, limit ${DIR_SIZE_LIMIT})`)

    const filename = safeKey(key) + ".md"
    const filepath = path.join(dir, filename)

    // Append with timestamp header if file exists, else create
    const existing = await Bun.file(filepath).text().catch(() => "")
    const timestamp = new Date().toISOString().split("T")[0]
    const entry = existing
      ? existing.trimEnd() + `\n\n<!-- updated ${timestamp} -->\n` + validation.sanitized + "\n"
      : `<!-- ${timestamp} -->\n${validation.sanitized}\n`

    await Bun.write(filepath, entry)
    log.info("team memory written", { key, filename, bytes: encoded })
    return filepath
  }

  /**
   * Read all facts from the shared team memory store.
   * Returns a map of key → content, empty map if no memory exists.
   */
  export async function readAll(): Promise<Map<string, string>> {
    const dir = memoryDir()
    const result = new Map<string, string>()
    const entries = await fs.readdir(dir).catch(() => [] as string[])
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue
      const content = await Bun.file(path.join(dir, entry)).text().catch(() => "")
      result.set(entry.replace(/\.md$/, ""), content)
    }
    return result
  }

  /**
   * Build the team memory system prompt fragment.
   * Returns empty string if no memory exists.
   */
  export async function systemPromptFragment(): Promise<string> {
    const memory = await readAll()
    if (memory.size === 0) return ""
    const lines = ["## Team Memory (shared across all teammates)\n"]
    for (const [key, content] of memory) {
      lines.push(`### ${key}\n${content.trim()}\n`)
    }
    return lines.join("\n")
  }

  /** Delete a specific memory key */
  export async function remove(key: string): Promise<void> {
    const filepath = path.join(memoryDir(), safeKey(key) + ".md")
    await fs.unlink(filepath).catch(() => {})
    log.info("team memory removed", { key })
  }

  /** Delete all team memory for this project */
  export async function clear(): Promise<void> {
    const dir = memoryDir()
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    log.info("team memory cleared")
  }
}
