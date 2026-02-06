/**
 * PTY Test Harness for OpenCode TUI
 *
 * Spawns the TUI in a pseudo-terminal using bun-pty and provides
 * helpers for sending input and asserting on rendered output.
 *
 * Usage:
 *   const tui = await TuiHarness.spawn({ env: {...} })
 *   await tui.waitForText("opencode")
 *   tui.write("\x14")  // Ctrl+T
 *   await tui.waitForText("No active team")
 *   tui.kill()
 */

import { spawn, type IPty } from "bun-pty"

/** Strip ANSI escape sequences from terminal output */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "") // OSC sequences
    .replace(/\x1b\[[\?]?[0-9;]*[a-zA-Z]/g, "") // CSI sequences
    .replace(/\x1b[()][A-Z0-9]/g, "") // Character set selection
    .replace(/\x1b[=>]/g, "") // Keypad modes
    .replace(/[\x00-\x08\x0e-\x1f]/g, "") // Control chars except \t \n \r
}

export interface TuiHarnessOptions {
  /** Extra environment variables */
  env?: Record<string, string>
  /** Working directory */
  cwd?: string
  /** Terminal columns (default 120) */
  cols?: number
  /** Terminal rows (default 40) */
  rows?: number
  /** Timeout for spawn in ms (default 30000) */
  spawnTimeout?: number
}

export class TuiHarness {
  private pty: IPty
  private buffer: string = ""
  private disposed = false

  private constructor(pty: IPty) {
    this.pty = pty
    pty.onData((data) => {
      this.buffer += data
    })
  }

  /**
   * Spawn the TUI in a PTY and wait for initial render.
   */
  static async spawn(opts: TuiHarnessOptions = {}): Promise<TuiHarness> {
    const cwd = opts.cwd ?? process.cwd()
    const cols = opts.cols ?? 120
    const rows = opts.rows ?? 40
    const timeout = opts.spawnTimeout ?? 30000

    // Build isolated environment
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      TERM: "xterm-256color",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
      OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
      OPENCODE_DISABLE_SHARE: "true",
      // Disable terminal title sequences that pollute output
      OPENCODE_DISABLE_TERMINAL_TITLE: "true",
      ...opts.env,
    }

    const entryPoint = new URL(
      "../../src/index.ts",
      import.meta.url,
    ).pathname

    // opencode needs --conditions=browser for SolidJS JSX runtime.
    // The TUI command accepts [project] as a positional arg and
    // calls process.chdir(project). We run from the opencode package
    // root so module resolution works, passing cwd as the project path.
    const opencodeRoot = new URL("../../", import.meta.url).pathname

    const pty = spawn("bun", [
      "run",
      "--conditions=browser",
      entryPoint,
      cwd,
    ], {
      name: "xterm-256color",
      cwd: opencodeRoot,
      env,
      cols,
      rows,
    })

    const harness = new TuiHarness(pty)

    // Wait for TUI to render something (the prompt or home screen)
    try {
      await harness.waitForText("opencode", timeout)
    } catch {
      // Even if we don't see "opencode" text, the TUI may still be running.
      // Don't fail on initial render — tests will fail on their own assertions.
    }

    return harness
  }

  /**
   * Get the raw buffer (includes ANSI escape codes).
   */
  get rawOutput(): string {
    return this.buffer
  }

  /**
   * Get cleaned text content (ANSI stripped).
   */
  get text(): string {
    return stripAnsi(this.buffer)
  }

  /**
   * Clear the buffer to start fresh for new assertions.
   */
  clearBuffer(): void {
    this.buffer = ""
  }

  /**
   * Write raw data to the PTY (keystrokes, text, control sequences).
   */
  write(data: string): void {
    if (this.disposed) throw new Error("TuiHarness already disposed")
    this.pty.write(data)
  }

  /**
   * Send a key combination. Common shortcuts:
   * - Ctrl+T: "\x14"
   * - Ctrl+B: "\x02"
   * - Ctrl+C: "\x03"
   * - Escape: "\x1b"
   * - Enter: "\r"
   * - Up: "\x1b[A"
   * - Down: "\x1b[B"
   */
  sendKey(key: string): void {
    this.write(key)
  }

  /**
   * Send Ctrl+<letter> (a-z).
   */
  sendCtrl(letter: string): void {
    const code = letter.toLowerCase().charCodeAt(0) - 96
    this.write(String.fromCharCode(code))
  }

  /**
   * Type text followed by Enter.
   */
  submit(text: string): void {
    this.write(text)
    this.write("\r")
  }

  /**
   * Wait until the stripped text output contains the given string.
   * Polls every 100ms.
   */
  async waitForText(
    text: string,
    timeoutMs: number = 10000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.text.includes(text)) return
      await sleep(100)
    }
    throw new Error(
      `Timeout waiting for text "${text}" after ${timeoutMs}ms.\n` +
        `Buffer (stripped, last 2000 chars):\n${this.text.slice(-2000)}`,
    )
  }

  /**
   * Wait until the stripped text output matches a regex.
   */
  async waitForMatch(
    pattern: RegExp,
    timeoutMs: number = 10000,
  ): Promise<RegExpMatchArray> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const match = this.text.match(pattern)
      if (match) return match
      await sleep(100)
    }
    throw new Error(
      `Timeout waiting for pattern ${pattern} after ${timeoutMs}ms.\n` +
        `Buffer (stripped, last 2000 chars):\n${this.text.slice(-2000)}`,
    )
  }

  /**
   * Assert that text does NOT appear within a time window.
   */
  async assertNoText(
    text: string,
    windowMs: number = 2000,
  ): Promise<void> {
    const deadline = Date.now() + windowMs
    while (Date.now() < deadline) {
      if (this.text.includes(text)) {
        throw new Error(
          `Text "${text}" unexpectedly appeared in output.\n` +
            `Buffer (stripped, last 1000 chars):\n${this.text.slice(-1000)}`,
        )
      }
      await sleep(100)
    }
  }

  /**
   * Wait a fixed time for UI to settle.
   */
  async settle(ms: number = 500): Promise<void> {
    await sleep(ms)
  }

  /**
   * Kill the PTY process.
   */
  kill(signal?: string): void {
    if (this.disposed) return
    this.disposed = true
    try {
      this.pty.kill(signal ?? "SIGTERM")
    } catch {
      // May already be dead
    }
  }

  /**
   * Wait for the PTY to exit.
   */
  async waitForExit(timeoutMs: number = 5000): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Timeout waiting for PTY exit"))
      }, timeoutMs)

      this.pty.onExit((evt) => {
        clearTimeout(timer)
        resolve(evt.exitCode)
      })
    })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
