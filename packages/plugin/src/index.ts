import type {
  Event,
  createOpencodeClient,
  Project,
  Model,
  Provider,
  Permission,
  UserMessage,
  Message,
  Part,
  Auth,
  Config,
} from "@opencode-ai/sdk"

import type { BunShell } from "./shell"
import { type ToolDefinition } from "./tool.js"

export * from "./tool.js"

export type ProviderContext = {
  source: "env" | "config" | "custom" | "api"
  info: Provider
  options: Record<string, any>
}

export type PluginInput = {
  client: ReturnType<typeof createOpencodeClient>
  project: Project
  directory: string
  worktree: string
  serverUrl: URL
  $: BunShell
}

export type Plugin = (input: PluginInput) => Promise<Hooks>

export type AuthStrategy = "api-key" | "jwt" | "spiffe" | "oauth2" | "oidc" | "plugin"

/**
 * The authorization decision returned by an `a2a.authz` hook.
 *
 * - `allow: true` — permit the request. `reason` is optional and used for audit logging only.
 * - `allow: false` — deny the request. `reason` is surfaced in the response error body.
 *   `status_code` defaults to `403` if omitted.
 *
 * Leave `output.decision` as `undefined` to **abstain** — the next registered hook is tried,
 * and the request is allowed if all hooks abstain.
 */
export type A2AAuthzDecision = {
  allow: boolean
  /** Human-readable reason. Surfaced in error body on deny; used for audit logs on allow. */
  reason?: string
  /**
   * Optional deny status hint.
   * Runtime policy maps unauthenticated failures to `401` and
   * authenticated authorization denials to `403`.
   */
  status_code?: 401 | 403
}

/**
 * Input provided to every `a2a.authz` hook invocation.
 */
export type A2AAuthzInput = {
  /** The A2A agent ID being accessed. */
  agent: string
  /**
   * The action being authorized.
   * - `"invoke"` — protected agent task/message route.
   * - `"view"` — discovery route (agent card or agent listing).
   */
  action: "invoke" | "view"
  /** HTTP method of the incoming request (e.g. `"POST"`, `"GET"`). */
  method: string
  /** Request path (e.g. `/a2a/my-agent/message:send`). */
  path: string
  /**
   * Sanitized request headers. Credential headers (`Authorization`,
   * `X-A2A-Key`) are present as keys but their values are **redacted**
   * to `"[redacted]"` to prevent credential leakage into plugins.
   */
  headers: Record<string, string>
  /**
   * Authentication strategy that successfully verified the caller.
   * `"none"` means the agent is public (no auth configured).
   */
  strategy: AuthStrategy | "none"
  /** Authenticated principal identity (e.g. SPIFFE ID, JWT `sub`, `"api-key"`). */
  principal: string
}

export type RouteDefinition = {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS" | "*"
  path: string
  auth?: AuthStrategy | AuthStrategy[]
  handler: (req: Request, params: Record<string, string>) => Promise<Response>
}

export type AuthHook = {
  provider: string
  loader?: (auth: () => Promise<Auth>, provider: Provider) => Promise<Record<string, any>>
  methods: (
    | {
        type: "oauth"
        label: string
        prompts?: Array<
          | {
              type: "text"
              key: string
              message: string
              placeholder?: string
              validate?: (value: string) => string | undefined
              condition?: (inputs: Record<string, string>) => boolean
            }
          | {
              type: "select"
              key: string
              message: string
              options: Array<{
                label: string
                value: string
                hint?: string
              }>
              condition?: (inputs: Record<string, string>) => boolean
            }
        >
        authorize(inputs?: Record<string, string>): Promise<AuthOuathResult>
      }
    | {
        type: "api"
        label: string
        prompts?: Array<
          | {
              type: "text"
              key: string
              message: string
              placeholder?: string
              validate?: (value: string) => string | undefined
              condition?: (inputs: Record<string, string>) => boolean
            }
          | {
              type: "select"
              key: string
              message: string
              options: Array<{
                label: string
                value: string
                hint?: string
              }>
              condition?: (inputs: Record<string, string>) => boolean
            }
        >
        authorize?(inputs?: Record<string, string>): Promise<
          | {
              type: "success"
              key: string
              provider?: string
            }
          | {
              type: "failed"
            }
        >
      }
  )[]
}

export type AuthOuathResult = { url: string; instructions: string } & (
  | {
      method: "auto"
      callback(): Promise<
        | ({
            type: "success"
            provider?: string
          } & (
            | {
                refresh: string
                access: string
                expires: number
                accountId?: string
              }
            | { key: string }
          ))
        | {
            type: "failed"
          }
      >
    }
  | {
      method: "code"
      callback(code: string): Promise<
        | ({
            type: "success"
            provider?: string
          } & (
            | {
                refresh: string
                access: string
                expires: number
                accountId?: string
              }
            | { key: string }
          ))
        | {
            type: "failed"
          }
      >
    }
)

export interface Hooks {
  event?: (input: { event: Event }) => Promise<void>
  config?: (input: Config) => Promise<void>
  "http.request"?: (
    input: {
      method: string
      path: string
      headers: Record<string, string>
      clientIP: string
    },
    output: {
      response?: {
        status: number
        body: string
        headers?: Record<string, string>
      }
    },
  ) => Promise<void>
  "http.route"?: RouteDefinition[]
  tool?: {
    [key: string]: ToolDefinition
  }
  auth?: AuthHook
  /**
   * **A2A Authorization Hook** (`a2a.authz`)
   *
   * Called on every authenticated A2A request **after** the built-in authn step
   * (API key, JWT, SPIFFE, OIDC, OAuth2) and **after** any configured `ext_authz`
   * gRPC check. Allows plugins to implement custom authorization logic — for
   * example, querying an OPA policy engine, a SpiceDB instance, or a simple ACL.
   *
   * ### Decision semantics
   *
   * Set `output.decision` to express an authorization decision:
   *
   * | `output.decision` | Effect |
   * |---|---|
   * | `undefined` (default) | Hook **abstains**. Next registered hook is tried. If all hooks abstain the request is **allowed**. |
   * | `{ allow: true }` | Request is **allowed**. Hook chain stops immediately. |
   * | `{ allow: false, reason?, status_code? }` | Request is **denied**. First denying hook wins. |
   *
   * If the hook **throws** or **times out**, the runtime treats it as a deny
   * with `status_code: 403` (fail-closed). To opt into fail-open, catch your
   * own errors inside the hook and return `{ allow: true }`.
   *
   * ### Actions
   *
   * - `"invoke"` — caller is sending a message or managing tasks (protected endpoint).
   * - `"view"` — caller is checking discovery (agent card / agent listing). Return
   *   `{ allow: false }` to hide the agent from discovery responses.
   *
   * ### Example
   *
   * ```typescript
   * import type { Plugin } from "@opencode-ai/plugin"
   *
   * export const MyAuthzPlugin: Plugin = async () => ({
   *   "a2a.authz": async (input, output) => {
   *     if (input.agent === "restricted-agent" && input.principal !== "spiffe://corp/svc") {
   *       output.decision = { allow: false, reason: "Access restricted", status_code: 403 }
   *     }
   *     // Leave output.decision undefined to abstain and defer to the next hook
   *   },
   * })
   * ```
   */
  "a2a.authz"?: (input: A2AAuthzInput, output: { decision?: A2AAuthzDecision }) => Promise<void>
  /**
   * Called when a new message is received
   */
  "chat.message"?: (
    input: {
      sessionID: string
      agent?: string
      model?: { providerID: string; modelID: string }
      messageID?: string
      variant?: string
    },
    output: { message: UserMessage; parts: Part[] },
  ) => Promise<void>
  /**
   * Modify parameters sent to LLM
   */
  "chat.params"?: (
    input: { sessionID: string; agent: string; model: Model; provider: ProviderContext; message: UserMessage },
    output: { temperature: number; topP: number; topK: number; options: Record<string, any> },
  ) => Promise<void>
  "chat.headers"?: (
    input: { sessionID: string; agent: string; model: Model; provider: ProviderContext; message: UserMessage },
    output: { headers: Record<string, string> },
  ) => Promise<void>
  "permission.ask"?: (input: Permission, output: { status: "ask" | "deny" | "allow" }) => Promise<void>
  "command.execute.before"?: (
    input: { command: string; sessionID: string; arguments: string },
    output: { parts: Part[] },
  ) => Promise<void>
  "tool.execute.before"?: (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: any },
  ) => Promise<void>
  "shell.env"?: (
    input: { cwd: string; sessionID?: string; callID?: string },
    output: { env: Record<string, string> },
  ) => Promise<void>
  "tool.execute.after"?: (
    input: { tool: string; sessionID: string; callID: string; args: any },
    output: {
      title: string
      output: string
      metadata: any
    },
  ) => Promise<void>
  "experimental.chat.messages.transform"?: (
    input: {},
    output: {
      messages: {
        info: Message
        parts: Part[]
      }[]
    },
  ) => Promise<void>
  "experimental.chat.system.transform"?: (
    input: { sessionID?: string; model: Model },
    output: {
      system: string[]
    },
  ) => Promise<void>
  /**
   * Called before session compaction starts. Allows plugins to customize
   * the compaction prompt.
   *
   * - `context`: Additional context strings appended to the default prompt
   * - `prompt`: If set, replaces the default compaction prompt entirely
   */
  "experimental.session.compacting"?: (
    input: { sessionID: string },
    output: { context: string[]; prompt?: string },
  ) => Promise<void>
  "experimental.text.complete"?: (
    input: { sessionID: string; messageID: string; partID: string },
    output: { text: string },
  ) => Promise<void>
  /**
   * Modify tool definitions (description and parameters) sent to LLM
   */
  "tool.definition"?: (input: { toolID: string }, output: { description: string; parameters: any }) => Promise<void>
}
