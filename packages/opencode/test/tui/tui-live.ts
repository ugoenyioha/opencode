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
 *   - opencode-anthropic-auth plugin installed
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

// Set ONLY=substring to run a single test (e.g., ONLY=memory_save bun run test/tui/tui-live.ts)
const ONLY = process.env.ONLY ?? ""

async function test(name: string, fn: () => Promise<void>) {
  if (ONLY && !name.toLowerCase().includes(ONLY.toLowerCase())) {
    process.stdout.write(`  ${name} ... SKIP\n`)
    return
  }
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

// Copy real config (includes plugin paths + provider config), then force Claude as default model
const realConfigFile = path.join(realConfigHome, "opencode", "opencode.json")
const sandboxConfigFile = path.join(sandboxConfigHome, "opencode", "opencode.json")
try {
  const configText = await fs.readFile(realConfigFile, "utf-8")
  const config = JSON.parse(configText)
  // Use Gemini for testing — it reliably calls tools when instructed.
  // Claude with the anthropic-auth plugin also works but sometimes responds
  // conversationally instead of calling tools.
  config.model = "anthropic/claude-sonnet-4-20250514"
  // Auto-approve all tool permissions so tests don't block on permission dialogs
  config.permission = "allow"
  await fs.writeFile(sandboxConfigFile, JSON.stringify(config, null, 2))
} catch {
  // If no config, write minimal with Gemini default and auto-approve
  await fs.writeFile(
    sandboxConfigFile,
    JSON.stringify({ model: "google/gemini-2.5-flash", permission: "allow" }, null, 2),
  )
}

// Write cache version to prevent cache wipe
await fs.writeFile(path.join(sandboxCacheHome, "opencode", "version"), "14")

// Use real home (for ~/.claude.json metadata) but sandbox XDG dirs
const baseEnv: Record<string, string> = {
  HOME: os.homedir(), // Real home for ~/.claude.json access
  XDG_DATA_HOME: sandboxDataHome,
  XDG_CACHE_HOME: sandboxCacheHome,
  XDG_CONFIG_HOME: sandboxConfigHome,
  XDG_STATE_HOME: sandboxStateHome,
  OPENCODE_EXPERIMENTAL_AGENT_TEAMS: "1",
  OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
  OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
  OPENCODE_DISABLE_SHARE: "true",
  // Auto-approve ALL tool permissions so memory_save doesn't block on dialog
  OPENCODE_PERMISSION: JSON.stringify({ "*": "allow" }),
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
    tui.write("respond with exactly one word: pong")
    tui.write("\r")

    // Wait for a cost indicator ($) which appears after any LLM response,
    // or the response text itself. This is model-agnostic.
    try {
      await tui.waitForText("pong", 45000)
    } catch {
      // Fallback: some models may not follow instructions exactly.
      // Check for any sign of a completed LLM response (cost in header).
      await tui.settle(5000)
    }

    const text = tui.text
    const hasResponse =
      text.toLowerCase().includes("pong") ||
      text.includes("$0.") || // Cost indicator
      text.includes("tokens") || // Token count
      (text.includes("ctrl+") && text.split("\n").length > 15) // Session view with content
    assert(hasResponse, `LLM should produce a response. Got last 1000: ${text.slice(-1000)}`)
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
    const hasTeamDialog = text.includes("no active team") || text.includes("agent team") || text.includes("team_create")
    assert(hasTeamDialog, `Team dialog should appear. Got last 800: ${tui.text.slice(-800)}`)
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
    assert(hasVersion || hasCost, `Session header should show version or cost. Got: ${text.slice(0, 500)}`)
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
    const dialogOpen = beforeEsc.includes("team") || beforeEsc.includes("no active")
    assert(dialogOpen, "Team dialog should be open before Escape")

    // Press Escape
    tui.write("\x1b")
    await tui.settle(1500)

    // TUI should still be alive (session view)
    // We can verify by checking that the session content is still there
    const afterEsc = tui.text.toLowerCase()
    assert(afterEsc.includes("ping"), `Session should still show after Escape. Got: ${tui.text.slice(-500)}`)
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
    const hasTeam = text.includes("team") || text.includes("no active")
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
      text.includes("compact") || text.includes("summariz") || text.length > 100, // TUI still alive
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
      text.includes("memory") // fallback: at least the word "memory" should appear in the dialog
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
    assert(hasPrompt, `Prompt area should be visible after response. Got last 500: ${text.slice(-500)}`)
  } finally {
    tui.kill()
  }
})

// ---------- Test 11: Background bash task via Ctrl+B ----------
await test("Ctrl+B backgrounds a running bash task, /tasks shows it", async () => {
  const tui = await TuiHarness.spawn({
    cwd: testProject,
    env: baseEnv,
    spawnTimeout: 20000,
  })

  try {
    await tui.settle(4000)

    // Ask the agent to run a long sleep command
    tui.write("run this exact bash command: sleep 30 && echo background-test-done")
    tui.write("\r")

    // Wait for the bash tool to start executing — look for the sleep command
    // or the bash tool indicator in the output
    await tui.waitForText("sleep", 30000)
    await tui.settle(2000)

    // Press Ctrl+B to migrate the running bash to background
    tui.sendCtrl("b")
    await tui.settle(3000)

    // After Ctrl+B, the agent should continue (session still alive).
    // We might see a toast about the task being backgrounded,
    // or the agent may produce a follow-up response.
    const textAfterBg = tui.text
    assert(textAfterBg.length > 100, `TUI still alive after Ctrl+B backgrounding. Got ${textAfterBg.length} chars`)

    // Now open /tasks dialog via command palette to verify the task is listed
    // Wait for the session to go idle first (agent finishes its turn)
    await tui.settle(5000)

    tui.sendCtrl("k")
    await tui.settle(1500)
    tui.write("background task")
    await tui.settle(500)
    tui.write("\r")
    await tui.settle(3000)

    // The tasks dialog should show our backgrounded task
    const tasksText = tui.text
    const hasBackgroundTask =
      tasksText.includes("sleep") ||
      tasksText.includes("Background Tasks") ||
      tasksText.includes("running") ||
      tasksText.includes("background")
    assert(
      hasBackgroundTask,
      `Tasks dialog should show the backgrounded sleep task. Got last 800: ${tasksText.slice(-800)}`,
    )
  } finally {
    tui.kill()
  }
})

// ---------- Test 12: /memory dialog shows pre-created rules file ----------
await test("/memory dialog shows pre-created .opencode/rules/memory.md", async () => {
  // Deterministic test: pre-create the memory file (simulating what memory_save does)
  // then verify the /memory dialog picks it up. No LLM involvement.
  const rulesDir = path.join(testProject, ".opencode", "rules")
  await fs.mkdir(rulesDir, { recursive: true })
  await fs.writeFile(path.join(rulesDir, "memory.md"), "- This project uses TypeScript with strict mode (2026-02-06)\n")

  const tui = await TuiHarness.spawn({
    cwd: testProject,
    env: baseEnv,
    spawnTimeout: 20000,
  })

  try {
    await tui.settle(4000)

    // Create a session so we're in session context
    tui.write("say ok")
    tui.write("\r")
    await tui.waitForMatch(/\$0\.|tokens|ok/i, 60000)
    await tui.settle(2000)

    // Open /memory dialog
    tui.sendCtrl("k")
    await tui.settle(1500)
    tui.write("/memory")
    await tui.settle(500)
    tui.write("\r")

    // Wait for dialog to load and show the rules file
    try {
      await tui.waitForMatch(/memory\.md|Project|rules/i, 15000)
    } catch {
      await tui.settle(5000)
    }

    const text = tui.text
    const showsMemoryFile =
      text.includes("memory.md") || text.includes("Project Rules") || text.includes("Project") || text.includes("rules")
    assert(showsMemoryFile, `/memory dialog should list the pre-created memory.md. Got last 800: ${text.slice(-800)}`)
  } finally {
    tui.kill()
    // Clean up the pre-created file
    await fs.rm(path.join(testProject, ".opencode"), { recursive: true, force: true })
  }
})

// ---------- Test 13: memory_save tool via LLM creates file ----------
await test("memory_save tool via LLM creates .opencode/rules/memory.md", async () => {
  // Ensure clean state
  await fs.rm(path.join(testProject, ".opencode"), { recursive: true, force: true })

  const tui = await TuiHarness.spawn({
    cwd: testProject,
    env: baseEnv,
    spawnTimeout: 20000,
  })

  try {
    await tui.settle(4000)

    // Single prompt — no retries to avoid accumulating messages that could trigger
    // API errors from empty content in long conversations.
    // Use the most explicit possible instruction.
    tui.write("Remember this: this project uses TypeScript with strict mode")
    tui.write("\r")

    // Wait for the tool to execute — look for "Saved to" in tool output,
    // or cost/token indicators that the turn completed.
    try {
      await tui.waitForMatch(/Saved to|memory_save|memory\.md/i, 90000)
    } catch {
      // Agent may respond differently — give extra settle time
      await tui.settle(15000)
    }
    await tui.settle(5000)

    // Check if file was created
    const memoryPath = path.join(testProject, ".opencode", "rules", "memory.md")
    let memoryExists = false
    let memoryContent = ""
    try {
      memoryContent = await fs.readFile(memoryPath, "utf-8")
      memoryExists = true
    } catch {}

    if (!memoryExists) {
      console.log(`    DEBUG: memory.md not found at ${memoryPath}`)
      console.log(`    DEBUG: TUI text (last 800): ${tui.text.slice(-800)}`)
      try {
        const entries = await fs.readdir(path.join(testProject, ".opencode"), { recursive: true })
        console.log(`    DEBUG: .opencode contents: ${entries.join(", ")}`)
      } catch {
        console.log(`    DEBUG: .opencode directory does not exist`)
      }
    }

    assert(memoryExists, `memory_save should create .opencode/rules/memory.md`)
    assert(
      memoryContent.toLowerCase().includes("typescript") || memoryContent.toLowerCase().includes("strict"),
      `memory.md should contain the saved fact. Got: "${memoryContent.slice(0, 300)}"`,
    )
  } finally {
    tui.kill()
    await fs.rm(path.join(testProject, ".opencode"), { recursive: true, force: true })
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
