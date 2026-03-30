import { useDialog } from "@tui/ui/dialog"
import { DialogSelect, type DialogSelectOption, type DialogSelectRef } from "@tui/ui/dialog-select"
import { createMemo, onMount } from "solid-js"
import { useTheme } from "../context/theme"
import { useSync } from "../context/sync"
import { useToast } from "../ui/toast"
import { useRenderer } from "@opentui/solid"
import path from "path"
import fs from "fs"

interface MemoryFile {
  path: string
  exists: boolean
  label: string
  category: string
  modified?: number
}

function stamp(mtime?: number) {
  if (!mtime) return "new"
  const delta = Date.now() - mtime
  const days = Math.floor(delta / 86400000)
  if (days <= 0) return "today"
  if (days === 1) return "1d ago"
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months === 1) return "1mo ago"
  if (months < 12) return `${months}mo ago`
  const years = Math.floor(months / 12)
  return years === 1 ? "1y ago" : `${years}y ago`
}

/** Recursively find *.md files under a directory (sync) */
function findMarkdownFiles(dir: string): string[] {
  const results: string[] = []
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        results.push(...findMarkdownFiles(full))
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(full)
      }
    }
  } catch {}
  return results
}

/** Collect all memory files synchronously to avoid async scheduling issues in TUI */
function collectFiles(dir: string, home: string): MemoryFile[] {
  const result: MemoryFile[] = []

  // Project-level files
  const projectFiles = [
    path.join(dir, "AGENTS.md"),
    path.join(dir, ".opencode", "AGENTS.md"),
    path.join(dir, "CLAUDE.md"),
    path.join(dir, ".claude", "CLAUDE.md"),
  ]
  for (const p of projectFiles) {
    try {
      if (fs.existsSync(p)) {
        result.push({
          path: p,
          exists: true,
          label: path.relative(dir, p),
          category: "Project",
          modified: fs.statSync(p).mtimeMs,
        })
      }
    } catch {}
  }

  // If no project memory file exists, offer to create AGENTS.md
  if (!result.some((f) => f.category === "Project")) {
    result.push({
      path: path.join(dir, "AGENTS.md"),
      exists: false,
      label: "AGENTS.md (create new)",
      category: "Project",
      modified: undefined,
    })
  }

  // Project rules
  for (const file of findMarkdownFiles(path.join(dir, ".opencode", "rules"))) {
    result.push({
      path: file,
      exists: true,
      label: path.relative(dir, file),
      category: "Project Rules",
      modified: fs.statSync(file).mtimeMs,
    })
  }

  // .claude/rules for compatibility
  for (const file of findMarkdownFiles(path.join(dir, ".claude", "rules"))) {
    result.push({
      path: file,
      exists: true,
      label: path.relative(dir, file),
      category: "Project Rules (.claude)",
      modified: fs.statSync(file).mtimeMs,
    })
  }

  // Global instruction files
  const configDir = process.env["XDG_CONFIG_HOME"]
    ? path.join(process.env["XDG_CONFIG_HOME"], "opencode")
    : path.join(home, ".config", "opencode")
  const globalFiles = [path.join(configDir, "AGENTS.md"), path.join(home, ".claude", "CLAUDE.md")]
  for (const p of globalFiles) {
    let exists = false
    try {
      exists = fs.existsSync(p)
    } catch {}
    result.push({
      path: p,
      exists,
      label: p.replace(home, "~"),
      category: "Global",
      modified: exists ? fs.statSync(p).mtimeMs : undefined,
    })
  }

  // Global rules — ~/.config/opencode/rules/ and ~/.claude/rules/
  for (const file of findMarkdownFiles(path.join(configDir, "rules"))) {
    result.push({
      path: file,
      exists: true,
      label: file.replace(home, "~"),
      category: "Global Rules",
      modified: fs.statSync(file).mtimeMs,
    })
  }
  for (const file of findMarkdownFiles(path.join(home, ".claude", "rules"))) {
    result.push({
      path: file,
      exists: true,
      label: file.replace(home, "~"),
      category: "Global Rules (.claude)",
      modified: fs.statSync(file).mtimeMs,
    })
  }

  return result
}

export function DialogMemory() {
  const dialog = useDialog()
  const { theme } = useTheme()
  const sync = useSync()
  const toast = useToast()
  const renderer = useRenderer()
  let ref: DialogSelectRef<string>

  const directory = () => sync.data.path.directory || process.cwd()
  const home = process.env["HOME"] || process.env["USERPROFILE"] || ""

  // Use synchronous file scanning — async createResource hangs in the TUI
  // rendering context because promise microtask resolution is deferred
  const files = createMemo(() => collectFiles(directory(), home))

  const options = createMemo((): DialogSelectOption<string>[] => {
    return files().map((f) => ({
      title: f.label,
      description: `Updated ${stamp(f.modified)}`,
      value: f.path,
      category: f.category,
      gutter: f.exists ? <text fg={theme.success}>ok</text> : <text fg={theme.textMuted}>new</text>,
    }))
  })

  const openInEditor = async (filepath: string) => {
    const editor = process.env["VISUAL"] || process.env["EDITOR"]
    if (!editor) {
      toast.show({ message: "No $EDITOR set. Set VISUAL or EDITOR env var.", variant: "error" })
      return
    }

    // Create parent directory and file if needed
    const dir = path.dirname(filepath)
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch {}
    if (!fs.existsSync(filepath)) {
      fs.writeFileSync(filepath, `# Memory\n\nAdd project instructions, coding standards, and preferences here.\n`)
    }

    // Open in editor
    dialog.clear()
    renderer.suspend()
    renderer.currentRenderBuffer.clear()
    const parts = editor.split(" ")
    const proc = Bun.spawn({
      cmd: [...parts, filepath],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })
    await proc.exited
    renderer.currentRenderBuffer.clear()
    renderer.resume()
    renderer.requestRender()
    toast.show({ message: `Updated: ${filepath.replace(home, "~")}`, variant: "info" })
  }

  onMount(() => {
    dialog.setSize("large")
    setTimeout(() => ref?.reset(), 60)
  })

  return <DialogSelect ref={(value) => (ref = value)} title="Memory Files" options={options()} onSelect={(option) => openInEditor(option.value)} />
}
