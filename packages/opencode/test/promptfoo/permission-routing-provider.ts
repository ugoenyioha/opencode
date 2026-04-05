import type { ApiProvider, ProviderResponse } from "promptfoo"
import { exec } from "node:child_process"
import { promisify } from "node:util"

const execAsync = promisify(exec)

export default class PermissionRoutingProvider implements ApiProvider {
  id() {
    return "opencode:permission-routing"
  }

  async callApi(prompt: string, context?: { vars?: Record<string, unknown> }): Promise<ProviderResponse> {
    const scenario = String(context?.vars?.scenario || "")
    try {
      const { stdout, stderr } = await execAsync(
        `bun run test/promptfoo/permission-routing-runner.ts '${scenario}'`,
        { cwd: process.cwd(), timeout: 20000 },
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
