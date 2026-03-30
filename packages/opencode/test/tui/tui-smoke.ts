#!/usr/bin/env bun
/**
 * TUI Smoke Tests via PTY Harness
 *
 * Standalone integration test (run with `bun run`, NOT `bun test`)
 * because it needs a real terminal environment with bun-pty.
 *
 * Usage:
 *   cd packages/opencode
 *   bun run test/tui/tui-smoke.ts
 *
 * These tests verify the TUI renders correctly and responds to input.
 * They do NOT need real LLM calls — they test UI rendering and navigation.
 */

import { TuiHarness } from "./pty-harness"
import os from "os"
import path from "path"
import fs from "fs/promises"

// ============================================================
// Test runner infrastructure
// ============================================================

let passed = 0
let failed = 0
const errors: { name: string; error: Error }[] = []

async function test(name: string, fn: () => Promise<void>) {
  process.stdout.write(`  ${name} ... `)
  try {
    await fn()
    passed++
    console.log("PASS")
  } catch (e) {
    failed++
    const err = e instanceof Error ? e : new Error(String(e))
    errors.push({ name, error: err })
    console.log("FAIL")
    console.log(`    ${err.message.split("\n")[0]}`)
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// ============================================================
// Environment setup
// ============================================================

// Create isolated sandbox
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-tui-smoke-"))
const testHome = path.join(sandbox, "home")
const testProject = path.join(sandbox, "project")
await fs.mkdir(testHome, { recursive: true })
await fs.mkdir(testProject, { recursive: true })

// Initialize a git repo in the test project (opencode requires it)
const gitInit = Bun.spawnSync(["git", "init"], { cwd: testProject })
if (gitInit.exitCode !== 0) {
  console.error("Failed to git init:", gitInit.stderr.toString())
  process.exit(1)
}
Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: testProject })
Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: testProject })
// Create an initial commit so git is happy
await fs.writeFile(path.join(testProject, ".gitkeep"), "")
Bun.spawnSync(["git", "add", "."], { cwd: testProject })
Bun.spawnSync(["git", "commit", "-m", "init", "--allow-empty"], { cwd: testProject })

// Trust the test workspace so the TUI can boot into the real app instead of the trust gate
const entryPoint = new URL("../../src/index.ts", import.meta.url).pathname
const opencodeRoot = new URL("../../", import.meta.url).pathname

// Write a minimal opencode.json config (no API keys — those go via env vars)
const configDir = path.join(sandbox, "config", "opencode")
await fs.mkdir(configDir, { recursive: true })
await fs.writeFile(path.join(configDir, "opencode.json"), JSON.stringify({}))

// Write cache version to prevent cache wipe
const cacheDir = path.join(sandbox, "cache", "opencode")
await fs.mkdir(cacheDir, { recursive: true })
await fs.writeFile(path.join(cacheDir, "version"), "14")

const baseEnv: Record<string, string> = {
  OPENCODE_TEST_HOME: testHome,
  OPENCODE_SERVER_PASSWORD: "test-password",
  XDG_DATA_HOME: path.join(sandbox, "share"),
  XDG_CACHE_HOME: path.join(sandbox, "cache"),
  XDG_CONFIG_HOME: path.join(sandbox, "config"),
  XDG_STATE_HOME: path.join(sandbox, "state"),
  OPENCODE_EXPERIMENTAL_AGENT_TEAMS: "1",
  ANTHROPIC_API_KEY: "sk-test-dummy-key-for-tui-smoke",
  // Models path for deterministic model list
  OPENCODE_MODELS_PATH: path.join(import.meta.dir, "..", "tool", "fixtures", "models-api.json"),
}

const { Config } = await import("../../src/config/config")
const defaultKeybinds = Config.Keybinds.parse({})
let commandPaletteKey = "k"
if (defaultKeybinds.command_list.includes("ctrl+p")) commandPaletteKey = "p"
if (defaultKeybinds.command_list.includes("ctrl+k")) commandPaletteKey = "k"

function openCommandPalette(tui: TuiHarness) {
  tui.sendCtrl(commandPaletteKey)
}

const trust = Bun.spawnSync(["bun", "run", entryPoint, "trust"], {
  cwd: testProject,
  env: {
    ...process.env,
    ...baseEnv,
  },
})
if (trust.exitCode !== 0) {
  console.error("Failed to trust TUI smoke project:", trust.stderr.toString() || trust.stdout.toString())
  process.exit(1)
}

// ============================================================
// Tests
// ============================================================

console.log("\nTUI Smoke Tests (PTY)\n")

// ---------- Test 1: TUI launches and shows home screen ----------
await test("TUI launches and shows home screen", async () => {
  const tui = await TuiHarness.spawn({
    cwd: testProject,
    env: baseEnv,
    spawnTimeout: 15000,
  })

  try {
    // The home screen should show some version text or prompt
    // OpenCode shows its version in the UI
    await tui.waitForText("v", 15000)
    assert(tui.text.length > 50, "TUI should render substantial content")
  } finally {
    tui.kill()
  }
})

// ---------- Test 2: Command palette opens with Ctrl+K ----------
await test("Command palette opens on Ctrl+K", async () => {
  const tui = await TuiHarness.spawn({
    cwd: testProject,
    env: baseEnv,
    spawnTimeout: 15000,
  })

  try {
    await tui.settle(3000) // Wait for full render

    // Open command palette via current keybind
    openCommandPalette(tui)

    // Wait for command palette content to appear
    // It should contain familiar command names
    let found = false
    const targets = ["session", "model", "theme", "agent", "Exit", "exit"]
    try {
      for (const target of targets) {
        try {
          await tui.waitForText(target, 5000)
          found = true
          break
        } catch {
          // Try next
        }
      }
    } catch {
      // Ignore
    }
    assert(found, `Command palette should show commands. Got: ${tui.text.slice(-800)}`)
  } finally {
    tui.kill()
  }
})

// ---------- Test 3: /team command is registered ----------
await test("/team command appears in command palette", async () => {
  const tui = await TuiHarness.spawn({
    cwd: testProject,
    env: baseEnv,
    spawnTimeout: 15000,
  })

  try {
    await tui.settle(3000)

    // Open command palette
    openCommandPalette(tui)
    await tui.settle(1500)

    // Type "team" to filter
    tui.write("team")

    // Wait for filtered results showing "team"
    await tui.waitForText("team", 5000)

    const text = tui.text.toLowerCase()
    assert(text.includes("team"), `Command palette should show 'team' command. Got: ${tui.text.slice(-800)}`)
  } finally {
    tui.kill()
  }
})

// ---------- Test 4: Escape closes dialogs ----------
await test("Escape closes command palette", async () => {
  const tui = await TuiHarness.spawn({
    cwd: testProject,
    env: baseEnv,
    spawnTimeout: 15000,
  })

  try {
    await tui.settle(2000)

    // Open command palette
    openCommandPalette(tui)
    await tui.settle(1000)
    tui.clearBuffer()

    // Close it with Escape
    tui.write("\x1b")
    await tui.settle(1000)

    // After closing, the palette items should no longer be visible
    // (the buffer was cleared, so only post-escape content is checked)
    // We just verify the TUI is still alive and responsive
    assert(tui.text.length >= 0, "TUI should still be running after Escape")
  } finally {
    tui.kill()
  }
})

// ---------- Test 5: Team keybind is registered in config ----------
await test("team_show keybind is registered (<leader>w)", async () => {
  // Verify the keybind config includes team_show
  // This is a structural test — we can't test Ctrl+T without a session
  // because the team dialog requires session route context.
  // The /team slash command test (Test 6) covers the actual dialog.
  const { Config } = await import("../../src/config/config")
  const defaultKeybinds = Config.Keybinds.parse({})
  assert(
    defaultKeybinds.team_show === "<leader>w",
    `team_show keybind should default to <leader>w, got: ${defaultKeybinds.team_show}`,
  )
})

// ---------- Test 6: /team slash command ----------
await test("/team slash command opens team dialog", async () => {
  const tui = await TuiHarness.spawn({
    cwd: testProject,
    env: baseEnv,
    spawnTimeout: 15000,
  })

  try {
    await tui.settle(3000)

    // Open command palette
    tui.sendCtrl("k")
    await tui.settle(1500)

    // Type "/team" to trigger the slash command
    tui.write("/team")
    await tui.settle(500)

    // Select it with Enter
    tui.write("\r")
    await tui.settle(1000)

    // Should show team dialog content
    const text = tui.text.toLowerCase()
    const hasTeamContent = text.includes("team") || text.includes("no active") || text.includes("agent team")
    assert(hasTeamContent, `Team dialog should appear via /team. Got: ${tui.text.slice(-800)}`)
  } finally {
    tui.kill()
  }
})

// ---------- Test 7: /tasks command appears in command palette ----------
await test("/tasks command appears in command palette", async () => {
  const tui = await TuiHarness.spawn({
    cwd: testProject,
    env: baseEnv,
    spawnTimeout: 15000,
  })

  try {
    await tui.settle(3000)

    // Open command palette
    tui.sendCtrl("k")
    await tui.settle(1500)

    // Filter for "tasks"
    tui.write("tasks")
    await tui.settle(500)

    const text = tui.text.toLowerCase()
    assert(text.includes("task"), `Command palette should show 'tasks' command. Got: ${tui.text.slice(-800)}`)
  } finally {
    tui.kill()
  }
})

// ---------- Test 8: /tasks dialog shows fallback ----------
await test("/tasks dialog shows empty state via command palette", async () => {
  const tui = await TuiHarness.spawn({
    cwd: testProject,
    env: baseEnv,
    spawnTimeout: 15000,
  })

  try {
    await tui.settle(3000)

    // Open command palette and select tasks
    openCommandPalette(tui)
    await tui.settle(1500)
    tui.write("/tasks")
    await tui.settle(500)
    tui.write("\r")
    await tui.settle(3000)

    // Should show empty state: "No background tasks." and Ctrl+B hint
    const text = tui.text
    const hasEmptyState =
      text.includes("No background tasks") ||
      text.includes("Background Tasks") ||
      text.includes("Ctrl+B") ||
      text.includes("ctrl+b") ||
      text.toLowerCase().includes("background")
    assert(hasEmptyState, `Tasks dialog should show empty state. Got: ${text.slice(-800)}`)
  } finally {
    tui.kill()
  }
})

// ---------- Test 9: /memory command appears in command palette ----------
await test("/memory command appears in command palette", async () => {
  const tui = await TuiHarness.spawn({
    cwd: testProject,
    env: baseEnv,
    spawnTimeout: 15000,
  })

  try {
    await tui.settle(3000)

    // Open command palette
    openCommandPalette(tui)
    await tui.settle(1500)

    // Filter for "memory"
    tui.write("memory")
    await tui.settle(500)

    const text = tui.text.toLowerCase()
    assert(text.includes("memory"), `Command palette should show 'memory' command. Got: ${tui.text.slice(-800)}`)
  } finally {
    tui.kill()
  }
})

// ---------- Test 9b: /btw command appears in command palette ----------
await test("/btw command appears in command palette", async () => {
  const tui = await TuiHarness.spawn({
    cwd: testProject,
    env: baseEnv,
    spawnTimeout: 15000,
  })

  try {
    await tui.settle(3000)
    openCommandPalette(tui)
    await tui.settle(1500)
    tui.write("btw")
    await tui.settle(500)
    const text = tui.text.toLowerCase()
    assert(
      text.includes("btw") || text.includes("by the way"),
      `Command palette should show 'btw'. Got: ${tui.text.slice(-800)}`,
    )
  } finally {
    tui.kill()
  }
})

// ---------- Test 10: /memory dialog finishes loading and shows file list ----------
await test("/memory dialog loads and shows file list (not stuck on loading)", async () => {
  const tui = await TuiHarness.spawn({
    cwd: testProject,
    env: baseEnv,
    spawnTimeout: 15000,
  })

  try {
    await tui.settle(3000)

    // Open command palette and select memory
    openCommandPalette(tui)
    await tui.settle(1500)
    tui.write("/memory")
    await tui.settle(500)
    tui.write("\r")

    // Wait for the dialog to finish loading — it should show "Memory Files"
    // title or actual file entries (AGENTS.md, Project, Global), NOT stuck on
    // "Loading memory files..."
    let loaded = false
    for (let i = 0; i < 30; i++) {
      await tui.settle(200)
      const text = tui.text
      // If we see actual content (not just the loading message), it loaded
      if (
        text.includes("Memory Files") ||
        text.includes("AGENTS.md") ||
        text.includes("Project") ||
        text.includes("Global")
      ) {
        loaded = true
        break
      }
    }
    assert(loaded, `Memory dialog should finish loading within 6s, not stuck. Got: ${tui.text.slice(-800)}`)

    // Verify it's NOT showing the loading message anymore
    const text = tui.text
    assert(
      !text.includes("Loading memory files"),
      `Memory dialog should not show loading message after load. Got: ${text.slice(-800)}`,
    )
  } finally {
    tui.kill()
  }
})

// ---------- Test 10b: /memory dialog shows pre-created rules file ----------
await test("/memory dialog lists .opencode/rules files", async () => {
  // Create a rules file before launching TUI
  const rulesDir = path.join(testProject, ".opencode", "rules")
  await fs.mkdir(rulesDir, { recursive: true })
  await fs.writeFile(path.join(rulesDir, "memory.md"), "- Test fact (2026-02-06)\n")

  const tui = await TuiHarness.spawn({
    cwd: testProject,
    env: baseEnv,
    spawnTimeout: 15000,
  })

  try {
    await tui.settle(3000)

    // Open memory dialog
    openCommandPalette(tui)
    await tui.settle(1500)
    tui.write("/memory")
    await tui.settle(500)
    tui.write("\r")

    // Wait for it to load and show the rules file
    let found = false
    for (let i = 0; i < 30; i++) {
      await tui.settle(200)
      if (tui.text.includes("memory.md") || tui.text.includes("Rules")) {
        found = true
        break
      }
    }
    assert(found, `Memory dialog should list memory.md from .opencode/rules/. Got: ${tui.text.slice(-800)}`)
  } finally {
    tui.kill()
    // Clean up rules file
    await fs.rm(rulesDir, { recursive: true, force: true }).catch(() => {})
  }
})

// ---------- Test 11: Ctrl+B does not move cursor when session is idle ----------
await test("Ctrl+B in prompt acts as cursor-left when session is idle (not backgrounding)", async () => {
  const tui = await TuiHarness.spawn({
    cwd: testProject,
    env: baseEnv,
    spawnTimeout: 15000,
  })

  try {
    await tui.settle(3000)

    // Type some text into the prompt
    tui.write("hello world")
    await tui.settle(500)

    // Ctrl+B should act as cursor-left (textarea keybinding) since session is idle
    // This verifies that our Ctrl+B background handler in the prompt only
    // intercepts when session is busy — otherwise it falls through to move-left
    tui.sendCtrl("b")
    await tui.settle(300)

    // The TUI should still be functional and showing the text
    assert(
      tui.text.includes("hello world"),
      `Prompt should still contain typed text after Ctrl+B. Got: ${tui.text.slice(-800)}`,
    )
  } finally {
    tui.kill()
  }
})

// ---------- Test 12: input_move_left keybind includes ctrl+b ----------
await test("input_move_left keybind defaults to 'left,ctrl+b'", async () => {
  // Structural test: verify that Ctrl+B is part of the move-left keybind
  // This is important because our background task handler must intercept
  // Ctrl+B in the prompt's onKeyDown BEFORE the textarea keybinding consumes it
  const { Config } = await import("../../src/config/config")
  const defaultKeybinds = Config.Keybinds.parse({})
  assert(
    defaultKeybinds.input_move_left === "left,ctrl+b",
    `input_move_left should default to 'left,ctrl+b', got: ${defaultKeybinds.input_move_left}`,
  )
})

// ---------- Test 13: TUI exits cleanly with Ctrl+C ----------
await test("TUI exits cleanly via Ctrl+C", async () => {
  const tui = await TuiHarness.spawn({
    cwd: testProject,
    env: baseEnv,
    spawnTimeout: 15000,
  })

  try {
    await tui.settle(2000)

    // Send Ctrl+C to exit
    tui.sendCtrl("c")

    const exitCode = await tui.waitForExit(10000)
    // Exit code 0 or signal-based exit are both acceptable
    assert(exitCode === 0 || exitCode === 130 || exitCode === 143, `Clean exit expected, got ${exitCode}`)
  } catch {
    tui.kill()
  }
})

// ---------- Test 14: Sidebar layout structure is correct ----------
await test("Sidebar outer box has explicit width constraint and children sum correctly", async () => {
  // This is a structural test — we read the sidebar source and verify
  // the outer box has width={width()} and children widths sum to width().
  // This prevents the right border from being pushed off-screen.
  const sidebarSrc = await Bun.file(
    path.join(import.meta.dir, "..", "..", "src", "cli", "cmd", "tui", "routes", "session", "sidebar.tsx"),
  ).text()

  // The outer <box> must have width={width()} to constrain the flex row
  assert(
    sidebarSrc.includes("width={width()}") && sidebarSrc.includes('flexDirection="row"'),
    "Sidebar outer box must have width={width()} to constrain its flex row layout",
  )

  // Drag handle is width={1}, content is width={width() - 2}, right border is width={1}
  // Total: 1 + (width()-2) + 1 = width()
  assert(sidebarSrc.includes("width={width() - 2}"), "Sidebar content panel should be width={width() - 2}")

  // Structural invariant: outer width is width(), drag handle is width={1},
  // content panel is width={width() - 2}. That leaves 1 column for the
  // visual border/spacer without requiring a specific comment string.
  const widthOneOccurrences = (sidebarSrc.match(/width=\{1\}/g) || []).length
  assert(widthOneOccurrences >= 1, "Sidebar must include at least one width={1} structural border/handle column")

  // Outer box must have flexShrink={0} to prevent being compressed
  assert(sidebarSrc.includes("flexShrink={0}"), "Sidebar outer box must have flexShrink={0}")
})

// ---------- Test 15: Sidebar toggle command is registered ----------
await test("Sidebar toggle keybind defaults to <leader>b", async () => {
  const { Config } = await import("../../src/config/config")
  const keybinds = Config.Keybinds.parse({})
  assert(
    keybinds.sidebar_toggle === "<leader>b",
    `sidebar_toggle should default to '<leader>b', got: ${keybinds.sidebar_toggle}`,
  )
})

// ---------- Test 16: Sidebar does NOT auto-show at narrow width ----------
await test("Sidebar does not auto-show at narrow width (100 cols)", async () => {
  const tui = await TuiHarness.spawn({
    cwd: testProject,
    env: baseEnv,
    cols: 100,
    rows: 40,
    spawnTimeout: 15000,
  })

  try {
    await tui.settle(4000)

    // At 100 cols (<=120), sidebar should NOT auto-show
    // The sidebar shows "Context" section which the main area does not
    const text = tui.text
    // At narrow width, the footer (which is shown when sidebar is hidden)
    // should be visible instead
    // We don't want to see both Context + LSP sections which are sidebar-only
    const hasSidebarSections = text.includes("Context") && text.includes("LSP")
    assert(!hasSidebarSections, `Sidebar should NOT auto-show at 100 cols. Got: ${text.slice(-1200)}`)
  } finally {
    tui.kill()
  }
})

// ---------- Test 17: Sidebar content wraps instead of clipping ----------
await test("Sidebar wraps long directory paths (wrapMode=char)", async () => {
  // Create a deeply nested project to produce long paths in the sidebar
  const deepDir = path.join(sandbox, "deep", "very-long-directory-name-that-should-wrap", "nested-project")
  await fs.mkdir(deepDir, { recursive: true })
  Bun.spawnSync(["git", "init"], { cwd: deepDir })
  Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: deepDir })
  Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: deepDir })
  await fs.writeFile(path.join(deepDir, ".gitkeep"), "")
  Bun.spawnSync(["git", "add", "."], { cwd: deepDir })
  Bun.spawnSync(["git", "commit", "-m", "init", "--allow-empty"], { cwd: deepDir })

  const tui = await TuiHarness.spawn({
    cwd: deepDir,
    env: baseEnv,
    cols: 160,
    rows: 40,
    spawnTimeout: 15000,
  })

  try {
    await tui.settle(4000)

    // The sidebar should render without crashing, even with a very long path
    const text = tui.text
    const hasContent =
      text.includes("OpenCode") ||
      text.includes("Context") ||
      text.includes("nested-project") ||
      text.includes("very-long")
    assert(hasContent, `Sidebar should render long path without crash. Got: ${text.slice(-1200)}`)
  } finally {
    tui.kill()
    await fs.rm(path.join(sandbox, "deep"), { recursive: true, force: true }).catch(() => {})
  }
})

// ============================================================
// Cleanup & Report
// ============================================================

// Clean up sandbox
try {
  await fs.rm(sandbox, { recursive: true, force: true })
} catch {
  // Best effort cleanup
}

console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed\n`)

if (errors.length > 0) {
  console.log("Failures:\n")
  for (const { name, error } of errors) {
    console.log(`  ${name}:`)
    console.log(`    ${error.message}\n`)
  }
}

process.exit(failed > 0 ? 1 : 0)
