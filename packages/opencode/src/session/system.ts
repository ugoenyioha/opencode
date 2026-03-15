import { Ripgrep } from "../file/ripgrep"

import { Instance } from "../project/instance"
import { sanitizeFilePath } from "../util/input-sanitization"
import { Config } from "@/config/config"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_ANTHROPIC_WITHOUT_TODO from "./prompt/qwen.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"

import PROMPT_CODEX from "./prompt/codex_header.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Provider } from "@/provider/provider"

export namespace SystemPrompt {
  function withoutGit(prompt: string) {
    return prompt
      .replace(/\n## Git and workspace hygiene[\s\S]*?(?=\n## |$)/, "")
      .replace(/\n# Git[\s\S]*?(?=\n# |$)/, "")
  }

  async function format(prompt: string) {
    const config = await Config.get()
    if (config.experimental?.includeGitInstructions === false) return withoutGit(prompt)
    return prompt
  }

  export function instructions() {
    return PROMPT_CODEX.trim()
  }

  export async function provider(model: Provider.Model) {
    if (model.api.id.includes("gpt-5")) return [await format(PROMPT_CODEX)]
    if (model.api.id.includes("gpt-") || model.api.id.includes("o1") || model.api.id.includes("o3"))
      return [await format(PROMPT_BEAST)]
    if (model.api.id.includes("gemini-")) return [await format(PROMPT_GEMINI)]
    if (model.api.id.includes("claude")) return [await format(PROMPT_ANTHROPIC)]
    if (model.api.id.toLowerCase().includes("trinity")) return [await format(PROMPT_TRINITY)]
    return [await format(PROMPT_ANTHROPIC_WITHOUT_TODO)]
  }

  export async function environment(model: Provider.Model) {
    const project = Instance.project
    // G7 Security Fix: Sanitize working directory path to prevent prompt injection
    // via adversarial directory names. See: /tmp/audit-input-v2.md Pattern 2.1
    const sanitizedDirectory = sanitizeFilePath(Instance.directory)
    return [
      [
        `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
        `Here is some useful information about the environment you are running in:`,
        `<env>`,
        `  Working directory: ${sanitizedDirectory}`,
        `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
        `  Platform: ${process.platform}`,
        `  Today's date: ${new Date().toDateString()}`,
        `</env>`,
        `<directories>`,
        `  ${
          project.vcs === "git" && false
            ? await Ripgrep.tree({
                cwd: Instance.directory,
                limit: 50,
              })
            : ""
        }`,
        `</directories>`,
      ].join("\n"),
    ]
  }
}
