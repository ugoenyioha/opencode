import { useDialog } from "@tui/ui/dialog"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { createMemo, createResource, onMount, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useSync } from "../context/sync"
import { useToast } from "../ui/toast"
import { useRenderer } from "@opentui/solid"
import path from "path"

interface MemoryFile {
  path: string
  exists: boolean
  label: string
  category: string
}

export function DialogMemory() {
  const dialog = useDialog()
  const { theme } = useTheme()
  const sync = useSync()
  const toast = useToast()
  const renderer = useRenderer()

  const directory = () => sync.data.path.directory || process.cwd()
  const home = process.env["HOME"] || process.env["USERPROFILE"] || ""

  const [files] = createResource(async (): Promise<MemoryFile[]> => {
    const result: MemoryFile[] = []
    const dir = directory()

    // Project-level files
    const projectFiles = [
      path.join(dir, "AGENTS.md"),
      path.join(dir, ".opencode", "AGENTS.md"),
      path.join(dir, "CLAUDE.md"),
      path.join(dir, ".claude", "CLAUDE.md"),
    ]
    for (const p of projectFiles) {
      const exists = await Bun.file(p).exists()
      if (exists) {
        result.push({
          path: p,
          exists: true,
          label: path.relative(dir, p),
          category: "Project",
        })
      }
    }

    // If no project memory file exists, offer to create AGENTS.md
    if (!result.some((f) => f.category === "Project")) {
      result.push({
        path: path.join(dir, "AGENTS.md"),
        exists: false,
        label: "AGENTS.md (create new)",
        category: "Project",
      })
    }

    // Project rules
    const rulesDir = path.join(dir, ".opencode", "rules")
    try {
      const glob = new Bun.Glob("**/*.md")
      for await (const file of glob.scan({ cwd: rulesDir, absolute: true })) {
        result.push({
          path: file,
          exists: true,
          label: path.relative(dir, file),
          category: "Project Rules",
        })
      }
    } catch {}

    // Also check .claude/rules for compatibility
    const claudeRulesDir = path.join(dir, ".claude", "rules")
    try {
      const glob = new Bun.Glob("**/*.md")
      for await (const file of glob.scan({ cwd: claudeRulesDir, absolute: true })) {
        result.push({
          path: file,
          exists: true,
          label: path.relative(dir, file),
          category: "Project Rules (.claude)",
        })
      }
    } catch {}

    // Global files
    const configDir = process.env["XDG_CONFIG_HOME"]
      ? path.join(process.env["XDG_CONFIG_HOME"], "opencode")
      : path.join(home, ".config", "opencode")
    const globalFiles = [
      path.join(configDir, "AGENTS.md"),
      path.join(home, ".claude", "CLAUDE.md"),
    ]
    for (const p of globalFiles) {
      const exists = await Bun.file(p).exists()
      result.push({
        path: p,
        exists,
        label: p.replace(home, "~"),
        category: "Global",
      })
    }

    return result
  })

  const options = createMemo((): DialogSelectOption<string>[] => {
    const list = files() ?? []
    return list.map((f) => ({
      title: f.label,
      value: f.path,
      category: f.category,
      gutter: f.exists ? (
        <text fg={theme.success}>ok</text>
      ) : (
        <text fg={theme.textMuted}>new</text>
      ),
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
    await import("fs/promises").then((fs) => fs.mkdir(dir, { recursive: true })).catch(() => {})
    const file = Bun.file(filepath)
    if (!(await file.exists())) {
      await Bun.write(filepath, `# Memory\n\nAdd project instructions, coding standards, and preferences here.\n`)
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
  })

  return (
    <Show
      when={!files.loading}
      fallback={
        <box paddingLeft={2} paddingRight={2} paddingBottom={1}>
          <text fg={theme.textMuted}>Loading memory files...</text>
        </box>
      }
    >
      <DialogSelect
        title="Memory Files"
        options={options()}
        onSelect={(option) => openInEditor(option.value)}
      />
    </Show>
  )
}
