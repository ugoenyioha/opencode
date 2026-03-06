import path from "path"
import os from "os"
import matter from "gray-matter"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { Flag } from "@/flag/flag"
import { Log } from "../util/log"
import { Glob } from "../util/glob"
import { sanitizeFilePath, stripInvisibleUnicode } from "../util/input-sanitization"
import type { MessageV2 } from "./message-v2"

const log = Log.create({ service: "instruction" })

const FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "CONTEXT.md", // deprecated
]

function globalFiles() {
  const files = []
  if (Flag.OPENCODE_CONFIG_DIR) {
    files.push(path.join(Flag.OPENCODE_CONFIG_DIR, "AGENTS.md"))
  }
  files.push(path.join(Global.Path.config, "AGENTS.md"))
  if (!Flag.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT) {
    files.push(path.join(os.homedir(), ".claude", "CLAUDE.md"))
  }
  return files
}

async function resolveRelative(instruction: string): Promise<string[]> {
  if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
    return Filesystem.globUp(instruction, Instance.directory, Instance.worktree).catch(() => [])
  }
  if (!Flag.OPENCODE_CONFIG_DIR) {
    log.warn(
      `Skipping relative instruction "${instruction}" - no OPENCODE_CONFIG_DIR set while project config is disabled`,
    )
    return []
  }
  return Filesystem.globUp(instruction, Flag.OPENCODE_CONFIG_DIR, Flag.OPENCODE_CONFIG_DIR).catch(() => [])
}

interface RuleFile {
  filepath: string
  content: string
  /** Glob patterns for path-scoping. If empty, rule is unconditional. */
  paths: string[]
}

const PROJECT_RULES_DIRS = [
  // .opencode/rules/ (native)
  { base: ".opencode", sub: "rules" },
  // .claude/rules/ (compatibility)
  { base: ".claude", sub: "rules" },
]

async function scanDir(rulesDir: string): Promise<RuleFile[]> {
  const rules: RuleFile[] = []
  const glob = new Bun.Glob("**/*.md")
  try {
    for await (const file of glob.scan({ cwd: rulesDir, absolute: true, onlyFiles: true })) {
      try {
        const raw = await Bun.file(file).text()
        let frontmatter: Record<string, unknown> = {}
        let body = raw
        try {
          const parsed = matter(raw)
          frontmatter = (parsed.data ?? {}) as Record<string, unknown>
          body = parsed.content
        } catch {
          // No valid frontmatter — treat entire file as body
        }

        const paths: string[] = []
        if (Array.isArray(frontmatter.paths)) {
          for (const p of frontmatter.paths) {
            if (typeof p === "string") paths.push(p)
          }
        } else if (typeof frontmatter.paths === "string") {
          paths.push(frontmatter.paths)
        }

        const content = body.trim()
        if (content) {
          rules.push({ filepath: path.resolve(file), content, paths })
        }
      } catch (e) {
        log.warn("failed to read rule file", { file, error: e })
      }
    }
  } catch {
    // Rules directory doesn't exist — skip
  }
  return rules
}

async function scanRules(): Promise<RuleFile[]> {
  const rules: RuleFile[] = []

  // Project-local rules
  if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
    const root = Instance.directory
    for (const { base, sub } of PROJECT_RULES_DIRS) {
      rules.push(...(await scanDir(path.join(root, base, sub))))
    }
  }

  // Global rules — ~/.config/opencode/rules/ and ~/.claude/rules/
  rules.push(...(await scanDir(path.join(Global.Path.config, "rules"))))
  if (!Flag.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT) {
    rules.push(...(await scanDir(path.join(os.homedir(), ".claude", "rules"))))
  }

  return rules
}

export namespace InstructionPrompt {
  const state = Instance.state(() => {
    return {
      claims: new Map<string, Set<string>>(),
      rules: undefined as RuleFile[] | undefined,
    }
  })

  async function getRules(): Promise<RuleFile[]> {
    const s = state()
    if (s.rules === undefined) {
      s.rules = await scanRules()
    }
    return s.rules
  }

  function isClaimed(messageID: string, filepath: string) {
    const claimed = state().claims.get(messageID)
    if (!claimed) return false
    return claimed.has(filepath)
  }

  function claim(messageID: string, filepath: string) {
    const current = state()
    let claimed = current.claims.get(messageID)
    if (!claimed) {
      claimed = new Set()
      current.claims.set(messageID, claimed)
    }
    claimed.add(filepath)
  }

  export function clear(messageID: string) {
    state().claims.delete(messageID)
  }

  /** Invalidate the cached rules so they are re-scanned on next access. */
  export function invalidateRules() {
    state().rules = undefined
  }

  export async function systemPaths() {
    const config = await Config.get()
    const paths = new Set<string>()

    if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
      for (const file of FILES) {
        const matches = await Filesystem.findUp(file, Instance.directory, Instance.worktree)
        if (matches.length > 0) {
          matches.forEach((p) => {
            paths.add(path.resolve(p))
          })
          break
        }
      }
    }

    for (const file of globalFiles()) {
      if (await Filesystem.exists(file)) {
        paths.add(path.resolve(file))
        break
      }
    }

    if (config.instructions) {
      for (let instruction of config.instructions) {
        if (instruction.startsWith("https://") || instruction.startsWith("http://")) continue
        if (instruction.startsWith("~/")) {
          instruction = path.join(os.homedir(), instruction.slice(2))
        }
        const matches = path.isAbsolute(instruction)
          ? await Glob.scan(path.basename(instruction), {
              cwd: path.dirname(instruction),
              absolute: true,
              include: "file",
            }).catch(() => [])
          : await resolveRelative(instruction)
        matches.forEach((p) => {
          paths.add(path.resolve(p))
        })
      }
    }

    return paths
  }

  export async function system() {
    const config = await Config.get()
    const paths = await systemPaths()

    // G7 Security Fix: Sanitize file paths and content to prevent prompt injection
    // See: /tmp/audit-input-v2.md Patterns 2.1, 2.5
    const files = Array.from(paths).map(async (p) => {
      const content = await Filesystem.readText(p).catch(() => "")
      if (!content) return ""
      const sanitizedPath = sanitizeFilePath(p)
      const sanitizedContent = stripInvisibleUnicode(content)
      return "Instructions from: " + sanitizedPath + "\n" + sanitizedContent
    })

    const urls: string[] = []
    if (config.instructions) {
      for (const instruction of config.instructions) {
        if (instruction.startsWith("https://") || instruction.startsWith("http://")) {
          urls.push(instruction)
        }
      }
    }
    const fetches = urls.map((url) =>
      fetch(url, { signal: AbortSignal.timeout(5000) })
        .then((res) => (res.ok ? res.text() : ""))
        .catch(() => "")
        .then((x) => (x ? "Instructions from: " + url + "\n" + stripInvisibleUnicode(x) : "")),
    )

    // Unconditional rules from .opencode/rules/ and .claude/rules/ (frontmatter stripped)
    // G7 Security Fix: Sanitize rule content to prevent invisible Unicode injection
    const rules = await getRules()
    const ruleContents = rules
      .filter((r) => r.paths.length === 0)
      .map((r) => "Instructions from: " + sanitizeFilePath(r.filepath) + "\n" + stripInvisibleUnicode(r.content))

    return Promise.all([...files, ...fetches]).then((result) => [...result.filter(Boolean), ...ruleContents])
  }

  export function loaded(messages: MessageV2.WithParts[]) {
    const paths = new Set<string>()
    for (const msg of messages) {
      for (const part of msg.parts) {
        if (part.type === "tool" && part.tool === "read" && part.state.status === "completed") {
          if (part.state.time.compacted) continue
          const loaded = part.state.metadata?.loaded
          if (!loaded || !Array.isArray(loaded)) continue
          for (const p of loaded) {
            if (typeof p === "string") paths.add(p)
          }
        }
      }
    }
    return paths
  }

  export async function find(dir: string) {
    for (const file of FILES) {
      const filepath = path.resolve(path.join(dir, file))
      if (await Filesystem.exists(filepath)) return filepath
    }
  }

  export async function resolve(messages: MessageV2.WithParts[], filepath: string, messageID: string) {
    const system = await systemPaths()
    const already = loaded(messages)
    const results: { filepath: string; content: string }[] = []

    const target = path.resolve(filepath)
    let current = path.dirname(target)
    const root = path.resolve(Instance.directory)

    while (current.startsWith(root) && current !== root) {
      const found = await find(current)

      if (found && found !== target && !system.has(found) && !already.has(found) && !isClaimed(messageID, found)) {
        claim(messageID, found)
        const content = await Filesystem.readText(found).catch(() => undefined)
        if (content) {
          // G7 Security Fix: Sanitize file paths and content
          const sanitizedPath = sanitizeFilePath(found)
          const sanitizedContent = stripInvisibleUnicode(content)
          results.push({ filepath: found, content: "Instructions from: " + sanitizedPath + "\n" + sanitizedContent })
        }
      }
      current = path.dirname(current)
    }

    // Check path-scoped rules from .opencode/rules/ and .claude/rules/
    const rules = await getRules()
    const relativePath = path.relative(root, target)
    for (const rule of rules) {
      if (rule.paths.length === 0) continue // unconditional rules are in system prompt
      if (isClaimed(messageID, rule.filepath)) continue
      if (already.has(rule.filepath)) continue

      const matches = rule.paths.some((pattern) => {
        try {
          return new Bun.Glob(pattern).match(relativePath)
        } catch {
          return false
        }
      })

      if (matches) {
        claim(messageID, rule.filepath)
        // G7 Security Fix: Sanitize rule file paths and content
        const sanitizedPath = sanitizeFilePath(rule.filepath)
        const sanitizedContent = stripInvisibleUnicode(rule.content)
        results.push({
          filepath: rule.filepath,
          content: "Instructions from: " + sanitizedPath + "\n" + sanitizedContent,
        })
      }
    }

    return results
  }
}
