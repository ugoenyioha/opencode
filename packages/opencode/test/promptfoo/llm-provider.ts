import type { ApiProvider, ProviderResponse } from "promptfoo"
import { exec } from "node:child_process"
import { promisify } from "node:util"

const execAsync = promisify(exec)

function escape(s: string) {
  return s.replace(/'/g, "'\\''")
}

// LLM-in-the-loop provider for promptfoo.
// Sends the jailbreak prompt to a real LLM via the OpenCode engine,
// captures tool calls and text responses, and returns them for assertion.
//
// Config:
//   model: "anthropic/claude-sonnet-4-20250514" (required)
//   timeout: 60000 (optional, ms)
export default class LlmProvider implements ApiProvider {
  private model: string
  private timeout: number

  constructor(options?: { config?: { model?: string; timeout?: number }; id?: string }) {
    this.model = options?.config?.model || "anthropic/claude-sonnet-4-20250514"
    this.timeout = options?.config?.timeout || 90000
  }

  id() {
    return `opencode:llm:${this.model}`
  }

  async callApi(prompt: string): Promise<ProviderResponse> {
    try {
      const { stdout, stderr } = await execAsync(
        `bun run test/promptfoo/llm-runner.ts '${escape(this.model)}' '${escape(prompt)}' '${this.timeout}'`,
        {
          cwd: process.cwd(),
          timeout: this.timeout + 10000, // give extra 10s for process overhead
          maxBuffer: 1024 * 1024 * 10,
        },
      )
      return { output: (stdout + "\n" + stderr).trim() }
    } catch (error: any) {
      if (error.stdout || error.stderr) {
        return { output: ((error.stdout || "") + "\n" + (error.stderr || "")).trim() }
      }
      return { error: String(error) }
    }
  }
}
