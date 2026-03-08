import z from "zod"
import { spawn } from "child_process"
import { Tool } from "./tool"
import path from "path"
import os from "os"
import DESCRIPTION from "./bash.txt"
import { Log } from "../util/log"
import { Instance } from "../project/instance"
import { lazy } from "@/util/lazy"
import type Parser from "web-tree-sitter"
import { Language } from "web-tree-sitter"

import { $ } from "bun"
import { Filesystem } from "@/util/filesystem"
import { fileURLToPath } from "url"
import { Flag } from "@/flag/flag.ts"
import { Shell } from "@/shell/shell"

import { BashArity } from "@/permission/arity"
import { Truncate } from "./truncation"
import { Plugin } from "@/plugin"
import { scrubEnv } from "@/util/env"
import { TaskManager } from "@/task"
import type { ChildProcess } from "child_process"
import { Config } from "@/config/config"
import { Sandbox } from "@/sandbox"
import { FirecrackerSandbox } from "@/sandbox/firecracker"
import { BwrapSandbox } from "@/sandbox/bwrap"
import { LinuxSandbox } from "@/sandbox/linux"
import { GvisorSandbox } from "@/sandbox/gvisor"
import { hardenedMode } from "@/config/hardened"

const MAX_METADATA_LENGTH = 30_000
const DEFAULT_TIMEOUT = Flag.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS || 2 * 60 * 1000

export const log = Log.create({ service: "bash-tool" })

// Filesystem denylist — analogous to the SSRF IP denylist in Gate 8.
// These paths are never legitimate agent targets regardless of sandbox
// mode or permission settings. Hard-blocked at the AST layer.
const SENSITIVE_PATH_PREFIXES = [
  "/var/run/secrets/kubernetes.io/", // K8s ServiceAccount tokens
  "/etc/shadow", // password hashes
  "/etc/gshadow", // group password hashes
  "/etc/master.passwd", // BSD password file
]

const SENSITIVE_PATH_SUFFIXES = [
  "/.ssh/id_rsa",
  "/.ssh/id_ed25519",
  "/.ssh/id_ecdsa",
  "/.ssh/id_dsa",
  "/.aws/credentials",
  "/.config/gcloud/application_default_credentials.json",
  "/.docker/config.json",
  "/.kube/config",
  "/.gnupg/secring.gpg",
  "/.netrc",
]

function isSensitivePath(resolved: string): boolean {
  for (const prefix of SENSITIVE_PATH_PREFIXES) {
    if (resolved.startsWith(prefix)) return true
  }
  for (const suffix of SENSITIVE_PATH_SUFFIXES) {
    if (resolved.endsWith(suffix)) return true
  }
  return false
}

// --- Foreground process registry ---
// Tracks running bash tool processes so the TUI can migrate them to background.

export interface ForegroundProcess {
  callID: string
  sessionID: string
  pid: number
  command: string
  description: string
  workdir: string
  startTime: number
  process: ChildProcess
  output: string
  /** Resolves the tool execution promise when migrated */
  resolve: (result: { migrated: true; taskId: string }) => void
  migrated: boolean
}

const foregroundProcesses = Instance.state(
  () => new Map<string, ForegroundProcess>(),
  async (processes) => {
    for (const proc of processes.values()) {
      if (!proc.migrated && proc.process.exitCode === null) {
        try {
          proc.process.kill()
        } catch {}
      }
    }
    processes.clear()
  },
)

export function listForegroundProcesses(): ForegroundProcess[] {
  return Array.from(foregroundProcesses().values()).filter((p) => !p.migrated && p.process.exitCode === null)
}

/**
 * Migrate a foreground bash process to a background task.
 * Returns the new task ID, or null if the process can't be migrated.
 */
export async function migrateToBackground(callID: string): Promise<string | null> {
  const proc = foregroundProcesses().get(callID)
  if (!proc || proc.migrated || proc.process.exitCode !== null) return null

  log.info("migrating to background", { callID, pid: proc.pid, command: proc.command })

  const task = await TaskManager.adopt({
    process: proc.process,
    command: proc.command,
    workdir: proc.workdir,
    description: proc.description,
    initialOutput: proc.output,
    startTime: proc.startTime,
  })

  proc.migrated = true
  proc.resolve({ migrated: true, taskId: task.id })
  foregroundProcesses().delete(callID)

  log.info("migrated to background", { callID, taskId: task.id })
  return task.id
}

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const bashLanguage = await Language.load(bashPath)
  const p = new Parser()
  p.setLanguage(bashLanguage)
  return p
})

// TODO: we may wanna rename this tool so it works better on other shells
export const BashTool = Tool.define("bash", async () => {
  const shell = Shell.acceptable()
  log.info("bash tool using shell", { shell })

  return {
    description: DESCRIPTION.replaceAll("${directory}", Instance.directory)
      .replaceAll("${maxLines}", String(Truncate.MAX_LINES))
      .replaceAll("${maxBytes}", String(Truncate.MAX_BYTES)),
    parameters: z.object({
      command: z.string().describe("The command to execute"),
      timeout: z.number().describe("Optional timeout in milliseconds").optional(),
      unsafe: z.boolean().optional().describe("Allow unsafe shell execution"),
      workdir: z
        .string()
        .describe(
          `The working directory to run the command in. Defaults to ${Instance.directory}. Use this instead of 'cd' commands.`,
        )
        .optional(),
      description: z
        .string()
        .describe(
          "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: ls\nOutput: Lists files in current directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: mkdir foo\nOutput: Creates directory 'foo'",
        ),
    }),
    async execute(params, ctx) {
      const cwd = params.workdir || Instance.directory
      if (params.timeout !== undefined && params.timeout < 0) {
        throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
      }
      const timeout = params.timeout ?? DEFAULT_TIMEOUT
      const tree = await parser().then((p) => p.parse(params.command))
      if (!tree) {
        throw new Error("Failed to parse command")
      }
      const directories = new Set<string>()
      if (!Instance.containsPath(cwd)) directories.add(cwd)
      const patterns = new Set<string>()
      const always = new Set<string>()

      const stripQuotes = (s: string) => {
        if (s.length >= 2 && ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"')))) {
          return s.slice(1, -1)
        }
        return s
      }

      const parseAssignment = (text: string) => {
        const eq = text.indexOf("=")
        if (eq === -1) return null
        return { key: text.slice(0, eq), value: stripQuotes(text.slice(eq + 1)) }
      }

      const unsafeNodes = tree.rootNode.descendantsOfType([
        "pipeline",
        "command_substitution",
        "subshell",
        "expansion",
        "variable_expansion",
        "parameter_expansion",
        "simple_expansion",
        "brace_expansion",
        "redirected_statement",
        "process_substitution",
        "herestring_redirect",
      ])
      const assignmentNodes = tree.rootNode.descendantsOfType("variable_assignment")
      const commands = tree.rootNode.descendantsOfType("command")

      const env = assignmentNodes.reduce<Record<string, string>>((acc, node) => {
        if (!node) return acc
        const parsed = parseAssignment(node.text)
        if (!parsed) return acc
        acc[parsed.key] = parsed.value
        return acc
      }, {})

      const commandArgs = (node: NonNullable<(typeof commands)[number]>): string[] => {
        const argv: string[] = []
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i)
          if (!child) continue
          if (child.type === "variable_assignment") continue
          if (
            child.type !== "command_name" &&
            child.type !== "word" &&
            child.type !== "string" &&
            child.type !== "raw_string" &&
            child.type !== "concatenation" &&
            child.type !== "number"
          ) {
            continue
          }
          argv.push(stripQuotes(child.text))
        }
        return argv
      }

      const hasMultipleCommands = commands.length > 1

      let isUnsafeInterpreter = false
      if (!params.unsafe && commands.length > 0 && commands[0]) {
        const firstCmd = commandArgs(commands[0])
        if (firstCmd.length > 0 && ["bash", "sh", "zsh", "env", "ash", "dash"].includes(firstCmd[0])) {
          isUnsafeInterpreter = true
        }
      }

      const isUnsafe = unsafeNodes.length > 0 || hasMultipleCommands || isUnsafeInterpreter
      if (isUnsafe && !params.unsafe) {
        throw new Error(
          "Unsafe shell syntax or direct interpreter execution detected. Split into simpler commands or re-run with unsafe: true to acknowledge.",
        )
      }

      for (const node of commands) {
        if (!node) continue

        // Get full command text including redirects if present
        let commandText = node.parent?.type === "redirected_statement" ? node.parent.text : node.text

        const command = commandArgs(node)
        if (command.length > 0 && node.parent?.type !== "redirected_statement") {
          commandText = command.join(" ")
        }

        // not an exhaustive list, but covers most common cases
        if (["cd", "rm", "cp", "mv", "mkdir", "touch", "chmod", "chown", "cat"].includes(command[0])) {
          for (const arg of command.slice(1)) {
            if (arg.startsWith("-") || (command[0] === "chmod" && arg.startsWith("+"))) continue
            // Expand ~ to home directory for denylist matching
            const expanded = arg.startsWith("~/") ? path.join(os.homedir(), arg.slice(2)) : arg

            // Check the raw/expanded argument against the denylist first,
            // before realpath. This catches paths that don't exist on the
            // current machine (e.g., K8s SA token path on macOS dev boxes).
            if (isSensitivePath(expanded)) {
              throw new Error(`Access denied: '${arg}' targets a sensitive system path and is not permitted.`)
            }

            const resolved = await $`realpath ${arg}`
              .cwd(cwd)
              .quiet()
              .nothrow()
              .text()
              .then((x) => x.trim())
            log.info("resolved path", { arg, resolved })
            if (resolved) {
              const normalized =
                process.platform === "win32" ? Filesystem.windowsPath(resolved).replace(/\//g, "\\") : resolved

              // Hard-block sensitive filesystem paths — same pattern as
              // Gate 8 SSRF IP denylist. These are never legitimate agent
              // targets and must be blocked regardless of permission settings.
              if (isSensitivePath(normalized)) {
                throw new Error(`Access denied: '${arg}' targets a sensitive system path and is not permitted.`)
              }

              if (!Instance.containsPath(normalized)) {
                const dir = (await Filesystem.isDir(normalized)) ? normalized : path.dirname(normalized)
                directories.add(dir)
              }
            }
          }
        }

        // cd covered by above check
        if (command.length && command[0] !== "cd") {
          patterns.add(commandText)
          always.add(BashArity.prefix(command).join(" ") + " *")
        }
      }

      if (directories.size > 0) {
        const globs = Array.from(directories).map((dir) => {
          // Preserve POSIX-looking paths with /s, even on Windows
          if (dir.startsWith("/")) return `${dir.replace(/[\\/]+$/, "")}/*`
          return path.join(dir, "*")
        })
        await ctx.ask({
          permission: "external_directory",
          patterns: globs,
          always: globs,
          metadata: {},
        })
      }

      if (patterns.size > 0) {
        await ctx.ask({
          permission: "bash",
          patterns: Array.from(patterns),
          always: Array.from(always),
          metadata: {},
        })
      }

      const shellEnv = await Plugin.trigger("shell.env", { cwd, sessionID: ctx.sessionID, callID: ctx.callID }, {
        env: {},
        isSnapshotValid: false,
      } as { env: Record<string, string>; isSnapshotValid: boolean; passthrough?: string[] })
      const sandboxConfig = await Sandbox.getEffectiveConfig(ctx.agent)
      const mode = sandboxConfig.bash ?? "none"
      const available = Sandbox.available()

      // Explicit modes fail-fast, no silent downgrade
      if (mode === "bwrap" && !BwrapSandbox.available()) {
        throw new Error("Sandbox mode 'bwrap' requested but bubblewrap is not available on this platform")
      }
      if (mode === "namespace" && !LinuxSandbox.available()) {
        throw new Error(
          "Sandbox mode 'namespace' requested but Linux namespace sandbox is unavailable on this platform",
        )
      }
      if (mode === "gvisor" && !GvisorSandbox.available()) {
        throw new Error("Sandbox mode 'gvisor' requested but gVisor runsc binary is unavailable on this platform")
      }
      if (mode === "firecracker" && !FirecrackerSandbox.available()) {
        throw new Error(FirecrackerSandbox.unavailableMessage?.() || "Firecracker is unavailable")
      }

      // Auto mode: degrade on availability only, not runtime failure
      const selectedMode = mode === "auto" ? available : mode

      const shellFlags = shellEnv.isSnapshotValid ? "-c" : "-lc"

      // Merge all env sources, then scrub once with combined passthrough.
      // This closes the ShellEnvPlugin leak where shellEnv.env was applied
      // after scrubEnv, allowing secrets captured by `bash -lc` to bypass scrubbing.
      const passthrough = [
        ...(sandboxConfig.envPassthrough ?? []),
        ...Flag.OPENCODE_ENV_PASSTHROUGH,
        ...(shellEnv.passthrough ?? []),
      ]
      const merged = { ...process.env, ...shellEnv.env, ...env }
      const scrubbedEnv = scrubEnv(merged, passthrough)

      const sandboxOpts = {
        command: params.unsafe
          ? [shell, shellFlags, "--", params.command]
          : commands.length > 0 && commands[0]
            ? commandArgs(commands[0])
            : [],
        workdir: cwd,
        network: sandboxConfig.network ?? false,
        writable: [cwd, ...(sandboxConfig.writable ?? [])],
        memory: sandboxConfig.memory_mb,
        cpu: sandboxConfig.cpu_percent,
        env: scrubbedEnv,
      }

      const execArgs = params.unsafe
        ? [shell, shellFlags, "--", params.command]
        : commands.length > 0 && commands[0]
          ? commandArgs(commands[0])
          : []
      console.log("BASH EXEC ARGS:", execArgs)
      if (execArgs.length === 0) {
        throw new Error("No command to execute")
      }

      const proc =
        selectedMode === "none"
          ? spawn(execArgs[0], execArgs.slice(1), {
              shell: false,
              cwd,
              env: scrubbedEnv,
              stdio: ["ignore", "pipe", "pipe"],
              detached: process.platform !== "win32",
            })
          : Sandbox.spawnWith(selectedMode as Exclude<Sandbox.Backend, "none">, sandboxOpts)

      let output = ""
      const startTime = Date.now()
      const callID = ctx.callID ?? `bash_${Date.now()}_${Math.random().toString(36).slice(2)}`

      // Initialize metadata with process info (callID enables background migration from TUI)
      ctx.metadata({
        metadata: {
          output: "",
          description: params.description,
          callID,
          running: true,
        },
      })

      const append = (chunk: Buffer) => {
        output += chunk.toString()
        // Update foreground process output for migration
        const fg = foregroundProcesses().get(callID)
        if (fg) fg.output = output
        ctx.metadata({
          metadata: {
            // truncate the metadata to avoid GIANT blobs of data (has nothing to do w/ what agent can access)
            output: output.length > MAX_METADATA_LENGTH ? output.slice(0, MAX_METADATA_LENGTH) + "\n\n..." : output,
            description: params.description,
            callID,
            running: true,
          },
        })
      }

      proc.stdout?.on("data", append)
      proc.stderr?.on("data", append)

      let timedOut = false
      let aborted = false
      let exited = false
      let migrated = false
      let migratedTaskId: string | null = null

      const kill = () => Shell.killTree(proc, { exited: () => exited })

      if (ctx.abort.aborted) {
        aborted = true
        await kill()
      }

      const abortHandler = () => {
        aborted = true
        void kill()
      }

      ctx.abort.addEventListener("abort", abortHandler, { once: true })

      const timeoutTimer = setTimeout(() => {
        timedOut = true
        void kill()
      }, timeout + 100)

      const result = await new Promise<void | { migrated: true; taskId: string }>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timeoutTimer)
          ctx.abort.removeEventListener("abort", abortHandler)
          foregroundProcesses().delete(callID)
        }

        // Register for potential background migration
        foregroundProcesses().set(callID, {
          callID,
          sessionID: ctx.sessionID,
          pid: proc.pid!,
          command: params.command,
          description: params.description,
          workdir: cwd,
          startTime,
          process: proc,
          output,
          resolve: (migrationResult) => {
            migrated = true
            migratedTaskId = migrationResult.taskId
            cleanup()
            resolve(migrationResult)
          },
          migrated: false,
        })

        proc.once("exit", () => {
          exited = true
          cleanup()
          resolve()
        })

        proc.once("error", (error) => {
          exited = true
          cleanup()
          reject(error)
        })
      })

      // Handle migration: return immediately with task info
      if (migrated && migratedTaskId) {
        const msg = `Process migrated to background task.\nTask ID: ${migratedTaskId}\nOutput so far (${output.length} bytes) preserved.\n\nUse process_query tool to check on this task later.`
        return {
          title: params.description,
          metadata: {
            output: msg,
            exit: null as number | null,
            description: params.description,
            callID,
            running: false,
            taskId: migratedTaskId as string | undefined,
          },
          output: msg,
        }
      }

      const resultMetadata: string[] = []

      if (timedOut) {
        resultMetadata.push(`bash tool terminated command after exceeding timeout ${timeout} ms`)
      }

      if (aborted) {
        resultMetadata.push("User aborted the command")
      }

      if (resultMetadata.length > 0) {
        output += "\n\n<bash_metadata>\n" + resultMetadata.join("\n") + "\n</bash_metadata>"
      }

      return {
        title: params.description,
        metadata: {
          output: output.length > MAX_METADATA_LENGTH ? output.slice(0, MAX_METADATA_LENGTH) + "\n\n..." : output,
          exit: proc.exitCode,
          description: params.description,
          callID,
          running: false,
          taskId: undefined as string | undefined,
        },
        output,
      }
    },
  }
})
