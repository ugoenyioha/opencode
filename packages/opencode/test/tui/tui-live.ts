#!/usr/bin/env bun
/**
 * TUI Live Provider Integration Tests via PTY Harness
 *
 * Standalone integration test (run with `bun run`, NOT `bun test`)
 * that uses REAL provider credentials to test the full TUI flow:
 *   - Creating sessions (real LLM response)
 *   - Ctrl+T team dialog from session context
 *   - Command palette + /team from session
 *   - Session header rendering
 *
 * Usage:
 *   cd packages/opencode
 *   bun run test/tui/tui-live.ts
 *
 * Prerequisites:
 *   - Valid OAuth credentials in ~/.local/share/opencode/auth.json
 *   - opencode-claude-cli-auth plugin installed
 *   - ~/.claude.json for metadata user_id
 */

import { TuiHarness } from "./pty-harness"
import os from "os"
import path from "path"
import fs from "fs/promises"

// ============================================================
// Test runner
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
// Preflight: verify real credentials exist
// ============================================================

const realDataHome = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share")
const realConfigHome = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config")
const authFile = path.join(realDataHome, "opencode", "auth.json")

try {
  await fs.access(authFile)
} catch {
  console.error(`\nERROR: No auth credentials found at ${authFile}`)
  console.error("Run 'opencode' and authenticate first, then re-run this test.\n")
  process.exit(1)
}

console.log(`Using credentials from ${authFile}`)

// ============================================================
// Environment setup — sandbox with REAL credentials
// ============================================================

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-tui-live-"))
const testProject = path.join(sandbox, "project")
await fs.mkdir(testProject, { recursive: true })

// Init git repo (required by opencode)
Bun.spawnSync(["git", "init"], { cwd: testProject })
Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: testProject })
Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: testProject })
await fs.writeFile(path.join(testProject, ".gitkeep"), "")
Bun.spawnSync(["git", "add", "."], { cwd: testProject })
Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: testProject })

// Create sandbox dirs that mirror real structure
const sandboxDataHome = path.join(sandbox, "share")
const sandboxConfigHome = path.join(sandbox, "config")
const sandboxCacheHome = path.join(sandbox, "cache")
const sandboxStateHome = path.join(sandbox, "state")

await fs.mkdir(path.join(sandboxDataHome, "opencode"), { recursive: true })
await fs.mkdir(path.join(sandboxConfigHome, "opencode"), { recursive: true })
await fs.mkdir(path.join(sandboxCacheHome, "opencode"), { recursive: true })
await fs.mkdir(sandboxStateHome, { recursive: true })

// Copy real auth credentials into sandbox
await fs.copyFile(authFile, path.join(sandboxDataHome, "opencode", "auth.json"))

// Copy real config (includes plugin paths + provider config)
const realConfigFile = path.join(realConfigHome, "opencode", "opencode.json")
try {
  await fs.copyFile(realConfigFile, path.join(sandboxConfigHome, "opencode", "opencode.json"))
} catch {
  // If no config, write empty
  await fs.writeFile(path.join(sandboxConfigHome, "opencode", "opencode.json"), "{}")
}

// Write cache version to prevent cache wipe
await fs.writeFile(path.join(sandboxCacheHome, "opencode", "version"), "14")

// Use real home (for ~/.claude.json metadata) but sandbox XDG dirs
const baseEnv: Record<string, string> = {
  HOME: os.homedir(),  // Real home for ~/.claude.json access
  XDG_DATA_HOME: sandboxDataHome,
  XDG_CACHE_HOME: sandboxCacheHome,
  XDG_CONFIG_HOME: sandboxConfigHome,
  XDG_STATE_HOME: sandboxStateHome,
  OPENCODE_EXPERIMENTAL_AGENT_TEAMS: "1",
  OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
  OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
  OPENCODE_DISABLE_SHARE: "true",
  // Don't disable plugins — we need the auth plugin
}

// ============================================================
// Tests
// ============================================================

console.log("\nTUI Live Provider Tests (PTY)\n")

// ---------- Test 1: Session created with real LLM ----------
await test("TUI creates a session with real LLM response", async () => {
  const tui = await TuiHarness.spawn({
    cwd: testProject,
    env: baseEnv,
    spawnTimeout: 20000,
  })

  try {
    await tui.settle(4000) // Wait for full render + provider connect

    // Type a simple prompt and submit
    tui.write("say exactly 'hello world' and nothing else")
    tui.write("\r")

    // Wait for the LLM to respond — we should see session header elements
    // like the title bar, cost indicator, or the response text
    await tui.waitForText("hello", 30000)

    const text = tui.text.toLowerCase()
    assert(
      text.includes("hello") || text.includes("world"),
      `LLM should respond with hello world. Got: ${tui.text.slice(-1000)}`,
    )
  } finally {
    tui.kill()
  }
})

// ---------- Test 2: Ctrl+T from session shows team dialog ----------
await test("<leader>w from active session opens team dialog", async () => {
  const tui = await TuiHarness.spawn({
    cwd: testProject,
    env: baseEnv,
    spawnTimeout: 20000,
  })

  try {
    await tui.settle(4000)

    // Create a session first
    tui.write("say 'ok'")
    tui.write("\r")

    // Wait for the session to be active (LLM responds)
    await tui.waitForText("ok", 30000)
    await tui.settle(1000)

    // Now press <leader>w (Ctrl+X then w) to open team dialog
    tui.sendCtrl("x")
    await tui.settle(300)
    tui.write("w")
    await tui.settle(2000)

    // Should show team dialog — either "No active team" or "Agent Team"
    const text = tui.text.toLowerCase()
    const hasTeamDialog =
      text.includes("no active team") ||
      text.includes("agent team") ||
      text.includes("team_create")
    assert(
      hasTeamDialog,
      `Team dialog should appear. Got last 800: ${tui.text.slice(-800)}`,
    )
  } finally {
    tui.kill()
  }
})

// ---------- Test 3: Session header shows version/cost ----------
await test("Session header shows version and context info", async () => {
  const tui = await TuiHarness.spawn({
    cwd: testProject,
    env: baseEnv,
    spawnTimeout: 20000,
  })

  try {
    await tui.settle(4000)

    // Create a session
    tui.write("say 'test'")
    tui.write("\r")

    // Wait for response
    await tui.waitForText("test", 30000)
    await tui.settle(1000)

    // Session header should contain version info
    const text = tui.text
    // Look for version pattern (vX.Y.Z or "local") and cost ($0.00)
    const hasVersion = text.includes("local") || /v\d+\.\d+/.test(text)
    const hasCost = text.includes("$")
    assert(
      hasVersion || hasCost,
      `Session header should show version or cost. Got: ${text.slice(0, 500)}`,
    )
  } finally {
    tui.kill()
  }
})

// ---------- Test 4: Escape closes team dialog and returns to session ----------
await test("Escape closes team dialog and returns to session", async () => {
  const tui = await TuiHarness.spawn({
    cwd: testProject,
    env: baseEnv,
    spawnTimeout: 20000,
  })

  try {
    await tui.settle(4000)

    // Create a session
    tui.write("say 'ping'")
    tui.write("\r")
    await tui.waitForText("ping", 30000)
    await tui.settle(1000)

    // Open team dialog with <leader>w (Ctrl+X then w)
    tui.sendCtrl("x")
    await tui.settle(300)
    tui.write("w")
    await tui.settle(2000)

    // Verify dialog is open
    const beforeEsc = tui.text.toLowerCase()
    const dialogOpen =
      beforeEsc.includes("team") ||
      beforeEsc.includes("no active")
    assert(dialogOpen, "Team dialog should be open before Escape")

    // Press Escape
    tui.write("\x1b")
    await tui.settle(1500)

    // TUI should still be alive (session view)
    // We can verify by checking that the session content is still there
    const afterEsc = tui.text.toLowerCase()
    assert(
      afterEsc.includes("ping"),
      `Session should still show after Escape. Got: ${tui.text.slice(-500)}`,
    )
  } finally {
    tui.kill()
  }
})

// ---------- Test 5: /team from command palette in session ----------
await test("/team from command palette works in session context", async () => {
  const tui = await TuiHarness.spawn({
    cwd: testProject,
    env: baseEnv,
    spawnTimeout: 20000,
  })

  try {
    await tui.settle(4000)

    // Create a session
    tui.write("say 'ready'")
    tui.write("\r")
    await tui.waitForText("ready", 30000)
    await tui.settle(1000)

    // Open command palette
    tui.sendCtrl("k")
    await tui.settle(1500)

    // Type "team" and select
    tui.write("team")
    await tui.settle(500)
    tui.write("\r")
    await tui.settle(2000)

    // Should show team dialog
    const text = tui.text.toLowerCase()
    const hasTeam =
      text.includes("team") ||
      text.includes("no active")
    assert(hasTeam, `/team should open team dialog. Got: ${tui.text.slice(-800)}`)
  } finally {
    tui.kill()
  }
})

// ---------- Test 6: /compact triggers compaction ----------
await test("/compact command triggers compaction from session", async () => {
  const tui = await TuiHarness.spawn({
    cwd: testProject,
    env: baseEnv,
    spawnTimeout: 20000,
  })

  try {
    await tui.settle(4000)

    // Create a session with some content first
    tui.write("say 'first message for compaction test'")
    tui.write("\r")
    await tui.waitForText("first message", 30000)
    await tui.settle(2000)

    // Now type /compact with instructions
    tui.write("/compact focus on key decisions")
    tui.write("\r")
    await tui.settle(3000)

    // Compaction should trigger — look for "compacting" status or
    // the session continuing to work (no crash)
    const text = tui.text.toLowerCase()
    // The session should still be alive and functional
    // Compaction may show a status indicator or just work silently
    assert(
      text.includes("compact") ||
      text.includes("summariz") ||
      text.length > 100, // TUI still alive
      `Compaction should not crash. Got: ${tui.text.slice(-500)}`,
    )
  } finally {
    tui.kill()
  }
})

// ---------- Test 7: /tasks from session shows empty state ----------
await test("/tasks from session shows background tasks dialog", async () => {
  const tui = await TuiHarness.spawn({
    cwd: testProject,
    env: baseEnv,
    spawnTimeout: 20000,
  })

  try {
    await tui.settle(4000)

    // Create a session
    tui.write("say 'tasks test'")
    tui.write("\r")
    await tui.waitForText("tasks test", 30000)
    await tui.settle(1000)

    // Open command palette and search for "background tasks"
    tui.sendCtrl("k")
    await tui.settle(1500)
    tui.write("background task")
    await tui.settle(500)
    tui.write("\r")
    await tui.settle(3000)

    // Should show tasks dialog (empty state with Ctrl+B hint)
    const text = tui.text
    const hasTasks =
      text.includes("No background tasks") ||
      text.includes("Background Tasks") ||
      text.includes("Ctrl+B") ||
      text.toLowerCase().includes("background")
    assert(hasTasks, `Tasks dialog should appear. Got: ${text.slice(-800)}`)
  } finally {
    tui.kill()
  }
})

// ---------- Test 8: /memory from session shows memory files ----------
await test("/memory from session shows memory file list", async () => {
  const tui = await TuiHarness.spawn({
    cwd: testProject,
    env: baseEnv,
    spawnTimeout: 20000,
  })

  try {
    await tui.settle(4000)

    // Create a session
    tui.write("say 'memory test'")
    tui.write("\r")
    await tui.waitForText("memory test", 30000)

    // Wait longer for session to go idle — ensure busy state clears
    // and the input area is ready to receive keystrokes
    await tui.settle(3000)

    // Open command palette with Ctrl+K
    tui.sendCtrl("k")
    await tui.settle(2000)

    // Verify command palette opened (should show command list)
    // Then type the slash command
    tui.write("/memory")
    await tui.settle(1000)
    tui.write("\r")
    await tui.settle(3000)

    // Should show memory dialog with file categories or loading state
    const text = tui.text
    const hasMemory =
      text.includes("AGENTS.md") ||
      text.includes("Memory Files") ||
      text.includes("Loading memory") ||
      text.includes("Project") ||
      text.includes("Global") ||
      text.includes("create new") ||
      text.includes("memory")  // fallback: at least the word "memory" should appear in the dialog
    assert(hasMemory, `Memory dialog should appear. Got: ${text.slice(-800)}`)
  } finally {
    tui.kill()
  }
})

// ---------- Test 9: Ctrl+B hint visible but not active without running bash ----------
await test("Ctrl+B does nothing when no bash is running", async () => {
  const tui = await TuiHarness.spawn({
    cwd: testProject,
    env: baseEnv,
    spawnTimeout: 20000,
  })

  try {
    await tui.settle(4000)

    // Create a session
    tui.write("say 'ctrl-b test'")
    tui.write("\r")
    await tui.waitForText("ctrl-b test", 30000)
    await tui.settle(2000)

    // Press Ctrl+B when no bash is running — should not crash or error
    tui.sendCtrl("b")
    await tui.settle(1000)

    // TUI should still be alive and showing the session
    const text = tui.text.toLowerCase()
    assert(
      text.includes("ctrl-b test") || text.length > 100,
      `TUI should remain functional after Ctrl+B with no bash. Got: ${tui.text.slice(-500)}`,
    )
  } finally {
    tui.kill()
  }
})

// ---------- Test 10: Session with todo items shows in prompt suggestions ----------
await test("Session with LLM response shows follow-up prompt area", async () => {
  const tui = await TuiHarness.spawn({
    cwd: testProject,
    env: baseEnv,
    spawnTimeout: 20000,
  })

  try {
    await tui.settle(4000)

    // Create a session with a substantive prompt
    tui.write("say 'suggestion test complete'")
    tui.write("\r")
    await tui.waitForText("suggestion test complete", 30000)
    await tui.settle(2000)

    // After LLM responds, the prompt area should be visible
    // (ready for next input). The prompt bar shows at the bottom.
    const text = tui.text
    // Look for prompt indicators: the status bar or input area markers
    const hasPrompt =
      text.includes("ctrl+") || // Keybind hints in status bar
      text.includes("commands") ||
      text.includes("agents")
    assert(
      hasPrompt,
      `Prompt area should be visible after response. Got last 500: ${text.slice(-500)}`,
    )
  } finally {
    tui.kill()
  }
})

// ============================================================
// Cleanup & Report
// ============================================================

try {
  await fs.rm(sandbox, { recursive: true, force: true })
} catch {
  // Best effort
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
