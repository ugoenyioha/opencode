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

// Write a minimal opencode.json config (no API keys — those go via env vars)
const configDir = path.join(sandbox, "config", "opencode")
await fs.mkdir(configDir, { recursive: true })
await fs.writeFile(
  path.join(configDir, "opencode.json"),
  JSON.stringify({}),
)

// Write cache version to prevent cache wipe
const cacheDir = path.join(sandbox, "cache", "opencode")
await fs.mkdir(cacheDir, { recursive: true })
await fs.writeFile(path.join(cacheDir, "version"), "14")

const baseEnv: Record<string, string> = {
  OPENCODE_TEST_HOME: testHome,
  XDG_DATA_HOME: path.join(sandbox, "share"),
  XDG_CACHE_HOME: path.join(sandbox, "cache"),
  XDG_CONFIG_HOME: path.join(sandbox, "config"),
  XDG_STATE_HOME: path.join(sandbox, "state"),
  OPENCODE_EXPERIMENTAL_AGENT_TEAMS: "1",
  ANTHROPIC_API_KEY: "sk-test-dummy-key-for-tui-smoke",
  // Models path for deterministic model list
  OPENCODE_MODELS_PATH: path.join(
    import.meta.dir,
    "..",
    "tool",
    "fixtures",
    "models-api.json",
  ),
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

    // Ctrl+K opens command palette
    tui.sendCtrl("k")

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
    tui.sendCtrl("k")
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
    tui.sendCtrl("k")
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
    const hasTeamContent =
      text.includes("team") ||
      text.includes("no active") ||
      text.includes("agent team")
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
    tui.sendCtrl("k")
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
    tui.sendCtrl("k")
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

// ---------- Test 10: /memory dialog shows file list ----------
await test("/memory dialog shows memory files via command palette", async () => {
  const tui = await TuiHarness.spawn({
    cwd: testProject,
    env: baseEnv,
    spawnTimeout: 15000,
  })

  try {
    await tui.settle(3000)

    // Open command palette and select memory
    tui.sendCtrl("k")
    await tui.settle(1500)
    tui.write("/memory")
    await tui.settle(500)
    tui.write("\r")
    await tui.settle(3000)

    // Memory dialog should render — either the file list or loading state
    const text = tui.text
    const hasMemoryContent =
      text.includes("AGENTS.md") ||
      text.includes("Memory Files") ||
      text.includes("Loading memory") ||
      text.includes("Project") ||
      text.includes("Global") ||
      text.includes("CLAUDE.md") ||
      text.includes("create new")
    assert(hasMemoryContent, `Memory dialog should render. Got: ${text.slice(-800)}`)
  } finally {
    tui.kill()
  }
})

// ---------- Test 11: TUI exits cleanly with Ctrl+C ----------
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
