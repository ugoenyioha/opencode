import type { ApiProvider, ProviderResponse } from "promptfoo"
import { exec } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"

const execAsync = promisify(exec)

export default class OpenCodeProvider implements ApiProvider {
  id() {
    return "opencode:sandbox-redteam"
  }

  async callApi(prompt: string): Promise<ProviderResponse> {
    try {
      const { stdout, stderr } = await execAsync(`bun run test/promptfoo/runner.ts "${prompt.replace(/"/g, '\\"')}"`, {
        cwd: process.cwd(),
        timeout: 10000,
      })
      return { output: stdout + "\n" + stderr }
    } catch (error: any) {
      if (error.stdout || error.stderr) {
        return { output: (error.stdout || "") + "\n" + (error.stderr || "") }
      }
      return { error: String(error) }
    }
  }
}
