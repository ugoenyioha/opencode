import type { ApiProvider, ProviderResponse } from "promptfoo"
import { exec } from "node:child_process"
import { promisify } from "node:util"

const execAsync = promisify(exec)

function escape(s: string) {
  return s.replace(/'/g, "'\\''")
}

export default class OpenCodeProvider implements ApiProvider {
  id() {
    return "opencode:sandbox-redteam"
  }

  // promptfoo calls callApi(prompt, context) where context.vars holds the test variables.
  // We expect vars.command (the shell command) and vars.query (the natural language prompt).
  async callApi(prompt: string, context?: { vars?: Record<string, unknown> }): Promise<ProviderResponse> {
    const cmd = String(context?.vars?.command || prompt)
    const query = String(context?.vars?.query || "")
    try {
      const { stdout, stderr } = await execAsync(
        `bun run test/promptfoo/runner.ts '${escape(cmd)}' '${escape(query)}'`,
        { cwd: process.cwd(), timeout: 15000 },
      )
      return { output: stdout + "\n" + stderr }
    } catch (error: any) {
      if (error.stdout || error.stderr) {
        return { output: (error.stdout || "") + "\n" + (error.stderr || "") }
      }
      return { error: String(error) }
    }
  }
}
