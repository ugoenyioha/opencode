import type { Hooks, Plugin, RouteDefinition, AuthStrategy, A2AAuthzDecision } from "@opencode-ai/plugin"
import { Config } from "@/config/config"
import { ConfigMarkdown } from "@/config/markdown"
import { Skill } from "@/skill/skill"
import { Agent } from "@/agent/agent"
import { Log } from "@/util/log"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { MessageV2 } from "@/session/message-v2"
import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { Plugin as Plugins } from "@/plugin"
import { Database, eq, sql } from "@/storage/db"
import { bearerFromHeaders, verifyBearerForStrategy, type StrictBearerStrategy } from "../server/compat/auth"
import { validA2AApiKey, type AuthnResult } from "../server/auth-policy"
import { emitAuthDecision } from "../server/auth-observability"
import { mapA2AAuthzStatus } from "../server/authz-status"
import { A2ATaskTable } from "./a2a.sql"
// Auth is enforced per-agent in agentHandler() — agent config replaces server-level auth.

const log = Log.create({ service: "a2a" })

const JSON_MIME = "application/a2a+json"
const A2A_VERSION = "1.0"

// ============================================================================
// A2A Task Types
// ============================================================================

type TaskState =
  | "TASK_STATE_UNSPECIFIED"
  | "TASK_STATE_SUBMITTED"
  | "TASK_STATE_WORKING"
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_FAILED"
  | "TASK_STATE_CANCELED"
  | "TASK_STATE_INPUT_REQUIRED"
  | "TASK_STATE_REJECTED"
  | "TASK_STATE_AUTH_REQUIRED"

type A2AMessagePart = { text: string } | { file: { url: string; mimeType?: string } }

type A2AMessage = {
  messageId: string
  contextId?: string
  taskId?: string
  role: "ROLE_UNSPECIFIED" | "ROLE_USER" | "ROLE_AGENT"
  parts: A2AMessagePart[]
  metadata?: Record<string, unknown>
  extensions?: string[]
  referenceTaskIds?: string[]
}

type A2AArtifact = {
  artifactId: string
  name: string
  parts: A2AMessagePart[]
}

type A2ATask = {
  id: string
  contextId: string
  agentId: string
  sessionId?: string
  status: {
    state: TaskState
    message?: string
  }
  artifacts: A2AArtifact[]
  history: A2AMessage[]
  createdAt: number
  updatedAt: number
}

// ============================================================================
// Task Storage
// ============================================================================

function generateUUID(): string {
  return crypto.randomUUID()
}

function fromRow(row: typeof A2ATaskTable.$inferSelect): A2ATask {
  return {
    id: row.id,
    contextId: row.context_id,
    agentId: row.agent_id,
    sessionId: row.session_id ?? undefined,
    status: row.message
      ? {
          state: row.state as TaskState,
          message: row.message,
        }
      : {
          state: row.state as TaskState,
        },
    artifacts: (row.artifacts ?? []) as unknown[] as A2AArtifact[],
    history: (row.history ?? []) as unknown[] as A2AMessage[],
    createdAt: row.time_created,
    updatedAt: row.time_updated,
  }
}

function getTask(taskId: string): A2ATask | undefined {
  const row = Database.use((db) => db.select().from(A2ATaskTable).where(eq(A2ATaskTable.id, taskId)).get())
  if (!row) return
  return fromRow(row)
}

function setTask(task: A2ATask): void {
  Database.use((db) =>
    db
      .insert(A2ATaskTable)
      .values({
        id: task.id,
        context_id: task.contextId,
        agent_id: task.agentId,
        session_id: task.sessionId ?? null,
        state: task.status.state,
        message: task.status.message ?? null,
        artifacts: task.artifacts,
        history: task.history,
        time_created: task.createdAt,
        time_updated: task.updatedAt,
      })
      .onConflictDoUpdate({
        target: A2ATaskTable.id,
        set: {
          context_id: task.contextId,
          agent_id: task.agentId,
          session_id: task.sessionId ?? null,
          state: task.status.state,
          message: task.status.message ?? null,
          artifacts: task.artifacts,
          history: task.history,
          time_updated: task.updatedAt,
        },
      })
      .run(),
  )
}

function transitionTask(task: A2ATask, state: TaskState, message?: string): A2ATask {
  task.status = message ? { state, message } : { state }
  task.updatedAt = Date.now()
  setTask(task)
  return task
}

function listTasks(agentId?: string): A2ATask[] {
  const rows = Database.use((db) => {
    if (agentId) {
      return db.select().from(A2ATaskTable).where(eq(A2ATaskTable.agent_id, agentId)).all()
    }
    return db.select().from(A2ATaskTable).all()
  })
  return rows.map(fromRow)
}

function recoverTasks() {
  const stuck = Database.use((db) =>
    db
      .select()
      .from(A2ATaskTable)
      .where(sql`${A2ATaskTable.state} in ('TASK_STATE_WORKING', 'TASK_STATE_SUBMITTED')`)
      .all(),
  )

  const now = Date.now()
  for (const row of stuck) {
    Database.use((db) =>
      db
        .update(A2ATaskTable)
        .set({
          state: "TASK_STATE_FAILED",
          message: "Process restarted before task completion",
          time_updated: now,
        })
        .where(eq(A2ATaskTable.id, row.id))
        .run(),
    )
  }

  if (stuck.length > 0) {
    log.info("a2a task recovery", {
      failed: stuck.length,
    })
  }

  return stuck.length
}

function isTerminalState(state: TaskState): boolean {
  return ["TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_CANCELED", "TASK_STATE_REJECTED"].includes(state)
}

function sanitizeFailureMessage(fallback: string): string {
  return fallback.slice(0, 160)
}

// ============================================================================
// A2A Error Codes
// ============================================================================

type A2AErrorCode = -32006 | -32007 | -32009 | -32600 | -32602

function a2aError(code: A2AErrorCode, message: string, data?: unknown) {
  return json(
    {
      error: {
        code,
        message,
        ...(data ? { data } : {}),
      },
    },
    code === -32009 ? 400 : code === -32600 ? 400 : code === -32602 ? 400 : 400,
  )
}

// ============================================================================
// A2A Version Validation
// ============================================================================

function validateA2AVersion(req: Request): Response | undefined {
  const version = req.headers.get("A2A-Version")
  if (version && version !== A2A_VERSION) {
    return a2aError(-32009, "Version not supported", { supportedVersions: [A2A_VERSION] })
  }
  return undefined
}

function addA2AVersionHeader(response: Response): Response {
  response.headers.set("A2A-Version", A2A_VERSION)
  return response
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

function schemeMatchesStrategy(
  strategy: AuthStrategy,
  scheme: { type: "apiKey" | "http" | "mutualTls" | "oauth2" | "oidc"; scheme?: string; bearerFormat?: string },
) {
  if (strategy === "plugin") return false
  if (strategy === "api-key") return scheme.type === "apiKey"
  if (strategy === "oauth2") return scheme.type === "oauth2"
  if (strategy === "oidc") return scheme.type === "oidc"
  if (strategy === "jwt") {
    if (scheme.type !== "http") return false
    if ((scheme.scheme ?? "").toLowerCase() !== "bearer") return false
    return (scheme.bearerFormat ?? "").trim().toLowerCase() !== "jwt-svid"
  }
  if (strategy === "spiffe") {
    if (scheme.type !== "http") return false
    if ((scheme.scheme ?? "").toLowerCase() !== "bearer") return false
    return (scheme.bearerFormat ?? "").trim().toLowerCase() === "jwt-svid"
  }
  return false
}

function json(input: unknown, status = 200) {
  return new Response(JSON.stringify(input), {
    status,
    headers: {
      "content-type": JSON_MIME,
    },
  })
}

function sanitizeHeaders(headers: Headers) {
  const output: Record<string, string> = {}
  for (const [key, value] of headers.entries()) {
    const lower = key.toLowerCase()
    if (lower === "authorization" || lower === "x-a2a-key" || lower === "x-opencode-workload") {
      output[key] = "[redacted]"
      continue
    }
    output[key] = value
  }
  return output
}

function parsePath(url: string) {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

function securityRequirements(
  auth: AuthStrategy[],
  schemes: Record<string, { type: "apiKey" | "http" | "mutualTls" | "oauth2" | "oidc" }>,
) {
  return auth
    .flatMap((entry) => {
      return Object.entries(schemes)
        .filter(([_, value]) => schemeMatchesStrategy(entry, value))
        .map(([name]) => ({
          schemes: {
            [name]: { list: [] },
          },
        }))
    })
    .filter((value, index, list) => {
      const key = JSON.stringify(value)
      return list.findIndex((item) => JSON.stringify(item) === key) === index
    })
}

function cardSecuritySchemes(schemes: Record<string, any>) {
  const result: Record<string, any> = {}
  for (const [name, value] of Object.entries(schemes)) {
    if (value.type === "apiKey") {
      result[name] = {
        apiKeySecurityScheme: {
          location: value.location,
          name: value.name,
        },
      }
      continue
    }
    if (value.type === "http") {
      const parts = []
      if (value.jwksUrl) parts.push(`JWKS at ${value.jwksUrl}`)
      result[name] = {
        httpAuthSecurityScheme: {
          description: parts.length ? parts.join(". ") : undefined,
          scheme: value.scheme,
          bearerFormat: value.bearerFormat,
        },
      }
      continue
    }
    if (value.type === "mutualTls") {
      result[name] = {
        mutualTlsSecurityScheme: {
          description: value.trustDomain ? `Trust domain: ${value.trustDomain}` : undefined,
        },
      }
      continue
    }
    if (value.type === "oauth2") {
      result[name] = {
        oauth2SecurityScheme: value,
      }
      continue
    }
    if (value.type === "oidc") {
      result[name] = {
        openIdConnectSecurityScheme: {
          openIdConnectUrl: value.openIdConnectUrl,
        },
      }
    }
  }
  return result
}

// Skill metadata for A2A agent card
type SkillMeta = {
  id: string
  name: string
  description: string
  tags: string[]
  examples: string[]
  inputModes: string[]
  outputModes: string[]
  oasfSkills: Array<{ name: string; id: number }>
}

// A2A agent definition with resolved skills
type A2AAgent = {
  id: string
  name: string
  description: string
  version: string
  baseUrl: string
  auth: AuthStrategy[]
  skillRouting: "semantic" | "metadata"
  securitySchemes: Record<string, any>
  skills: SkillMeta[]
}

/**
 * Load skill metadata from frontmatter for A2A card generation.
 * Skills must explicitly opt-in via `a2a.expose: true`.
 */
async function loadSkillMeta(skillName: string): Promise<SkillMeta | undefined> {
  const allSkills = await Skill.all()
  const skill = allSkills.find((s) => s.name === skillName)
  if (!skill) {
    log.warn("skill not found for A2A agent", { skill: skillName })
    return undefined
  }

  const md = await ConfigMarkdown.parse(skill.location).catch(() => undefined)
  if (!md) return undefined

  const frontmatter = md.data as Record<string, any>
  const a2a = (frontmatter.a2a ?? {}) as Record<string, any>

  // Skills must explicitly opt-in to A2A exposure
  if (a2a.expose !== true) {
    log.debug("skill not exposed for A2A", { skill: skillName })
    return undefined
  }

  // Skills must have tags for A2A card
  const tags = Array.isArray(a2a.tags) ? a2a.tags.filter((x: unknown): x is string => typeof x === "string") : []
  if (!tags.length) {
    log.warn("skill has a2a.expose but missing tags", { skill: skillName })
    return undefined
  }

  return {
    id: skillName,
    name: skillName,
    description: skill.description,
    tags,
    examples: Array.isArray(a2a.examples)
      ? a2a.examples.filter((x: unknown): x is string => typeof x === "string")
      : [],
    inputModes: Array.isArray(a2a.inputModes)
      ? a2a.inputModes.filter((x: unknown): x is string => typeof x === "string")
      : ["text/plain"],
    outputModes: Array.isArray(a2a.outputModes)
      ? a2a.outputModes.filter((x: unknown): x is string => typeof x === "string")
      : ["text/plain"],
    oasfSkills: Array.isArray(frontmatter.oasf?.skills)
      ? frontmatter.oasf.skills
          .filter((x: any) => typeof x?.name === "string" && typeof x?.id === "number")
          .map((x: any) => ({ name: x.name, id: x.id }))
      : [],
  }
}

/**
 * Discover all agents with mode: "a2a" and resolve their skills.
 */
async function discoverA2AAgents(serverConfig: {
  baseUrl?: string
  auth?: string[]
  securitySchemes?: Record<string, any>
}): Promise<A2AAgent[]> {
  const agents = await Agent.list()
  const result: A2AAgent[] = []

  for (const agent of agents) {
    if (agent.mode !== "a2a") continue

    const id = agent.name
    const a2aConfig = agent.a2a ?? {}
    const skillNames = agent.skills ?? []

    // Load skill metadata for each referenced skill
    const skills: SkillMeta[] = []
    for (const skillName of skillNames) {
      const meta = await loadSkillMeta(skillName)
      if (meta) skills.push(meta)
    }

    if (!skills.length) {
      log.warn("A2A agent has no valid skills, skipping", { agent: id })
      continue
    }

    // Merge security schemes: agent-level overrides server-level
    const securitySchemes = {
      ...(serverConfig.securitySchemes ?? {}),
      ...(a2aConfig.securitySchemes ?? {}),
    }

    result.push({
      id,
      name: agent.name ?? id,
      description: agent.description ?? `A2A agent: ${id}`,
      version: a2aConfig.version ?? "1.0.0",
      baseUrl: (a2aConfig.baseUrl ?? serverConfig.baseUrl ?? "http://localhost:4096").replace(/\/$/, ""),
      auth:
        (a2aConfig.auth as AuthStrategy | AuthStrategy[] | undefined) !== undefined
          ? asArray(a2aConfig.auth as AuthStrategy | AuthStrategy[] | undefined)
          : asArray(serverConfig.auth as AuthStrategy | AuthStrategy[] | undefined),
      skillRouting: (a2aConfig.skillRouting as "semantic" | "metadata") ?? "semantic",
      securitySchemes,
      skills,
    })
  }

  return result
}

/**
 * Generate an A2A agent card for a single agent.
 */
/**
 * Generate an A2A agent card per the A2A HTTP+JSON v1.0 spec.
 * See: https://google.github.io/A2A/specification/
 */
function generateAgentCard(agent: A2AAgent) {
  return {
    name: agent.name,
    description: agent.description,
    version: agent.version,
    supportedInterfaces: [
      {
        url: `${agent.baseUrl}/a2a/${agent.id}`,
        protocolBinding: "HTTP+JSON",
        protocolVersion: "1.0",
      },
    ],
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extendedAgentCard: false,
    },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    securitySchemes: cardSecuritySchemes(agent.securitySchemes),
    // Per A2A spec, this field is "securityRequirements" (not "security")
    securityRequirements: securityRequirements(agent.auth, agent.securitySchemes),
    skills: agent.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      tags: skill.tags,
      examples: skill.examples,
      inputModes: skill.inputModes,
      outputModes: skill.outputModes,
      ...(skill.oasfSkills.length
        ? {
            extensions: {
              oasf: {
                skills: skill.oasfSkills,
              },
            },
          }
        : {}),
    })),
  }
}

// ============================================================================
// Request Types
// ============================================================================

type SendMessageRequest = {
  message: A2AMessage
  contextId?: string
  configuration?: {
    blocking?: boolean
    timeout?: number
    model?: string
  }
}

function resolveModel(input: SendMessageRequest["configuration"]) {
  const raw = input?.model
  if (!raw) return undefined
  if (typeof raw !== "string") {
    throw new Error("configuration.model must be a string in provider/model format")
  }
  const value = raw.trim()
  const split = value.indexOf("/")
  if (split <= 0 || split === value.length - 1) {
    throw new Error("configuration.model must use provider/model format")
  }
  return {
    providerID: value.slice(0, split),
    modelID: value.slice(split + 1),
  }
}

// ============================================================================
// Task Response Helpers
// ============================================================================

function taskResponse(task: A2ATask) {
  return {
    task: {
      id: task.id,
      contextId: task.contextId,
      status: task.status,
      artifacts: task.artifacts,
      history: task.history,
    },
  }
}

function statusUpdate(task: A2ATask) {
  return {
    statusUpdate: {
      taskId: task.id,
      contextId: task.contextId,
      status: task.status,
    },
  }
}

function artifactUpdate(task: A2ATask, artifact: A2AArtifact, append: boolean, lastChunk: boolean) {
  return {
    artifactUpdate: {
      taskId: task.id,
      contextId: task.contextId,
      artifact,
      append,
      lastChunk,
    },
  }
}

async function finalizeTaskFromSession(task: A2ATask, agentId: string, sessionID: string) {
  if (isTerminalState(task.status.state)) return

  const messages = await Session.messages({ sessionID })
  const lastAssistant = messages.findLast((m) => m.info.role === "assistant")
  if (lastAssistant) {
    const textParts = lastAssistant.parts
      .filter((p): p is MessageV2.TextPart => p.type === "text" && !p.synthetic)
      .map((p) => p.text)
      .join("\n")

    if (textParts) {
      const artifact: A2AArtifact = {
        artifactId: generateUUID(),
        name: `${agentId} output`,
        parts: [{ text: textParts }],
      }
      task.artifacts.push(artifact)
    }

    task.history.push({
      messageId: lastAssistant.info.id,
      role: "ROLE_AGENT",
      parts: [{ text: textParts || "Task completed." }],
    })
  }

  transitionTask(task, "TASK_STATE_COMPLETED")
}

function subscribeTaskLifecycle(task: A2ATask, agentId: string, sessionID: string, onUpdate?: (task: A2ATask) => void) {
  const unsubscribe = Bus.subscribe(SessionStatus.Event.Status, async (event) => {
    try {
      if (event.properties.sessionID !== sessionID) return
      if (isTerminalState(task.status.state)) {
        unsubscribe()
        return
      }
      if (event.properties.status.type !== "idle") return

      await finalizeTaskFromSession(task, agentId, sessionID)
      onUpdate?.(task)
      unsubscribe()
    } catch (error) {
      log.error("A2A session status handler failed", { taskId: task.id })
      if (!isTerminalState(task.status.state)) {
        transitionTask(task, "TASK_STATE_FAILED", sanitizeFailureMessage("Internal error processing request"))
        onUpdate?.(task)
      }
      unsubscribe()
    }
  })

  return unsubscribe
}

function taskEventStream(initialTask: A2ATask): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()

  return new ReadableStream({
    async start(controller) {
      let closed = false
      let terminalEmitted = false
      let pollTimer: ReturnType<typeof setInterval> | undefined

      const send = (payload: unknown) => {
        if (closed) return
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
      }

      const close = () => {
        if (closed) return
        closed = true
        if (pollTimer) clearInterval(pollTimer)
        controller.close()
      }

      const current = getTask(initialTask.id) ?? initialTask
      send(taskResponse(current))

      if (isTerminalState(current.status.state)) {
        close()
        return
      }

      if (!current.sessionId) {
        close()
        return
      }

      const emitTerminal = (latest: A2ATask, unsubscribe: () => void) => {
        if (terminalEmitted) return
        terminalEmitted = true
        send(statusUpdate(latest))
        for (const artifact of latest.artifacts) {
          send(artifactUpdate(latest, artifact, false, true))
        }
        unsubscribe()
        close()
      }

      const unsubscribe = Bus.subscribe(SessionStatus.Event.Status, async (event) => {
        if (closed) return

        const latest = getTask(initialTask.id)
        if (!latest) {
          unsubscribe()
          close()
          return
        }

        if (event.properties.sessionID !== latest.sessionId) return

        if (isTerminalState(latest.status.state)) {
          emitTerminal(latest, unsubscribe)
          return
        }

        send(statusUpdate(latest))
      })

      const latest = getTask(initialTask.id)
      if (latest && isTerminalState(latest.status.state) && !closed) {
        emitTerminal(latest, unsubscribe)
      }

      pollTimer = setInterval(() => {
        if (closed) return
        const latestTask = getTask(initialTask.id)
        if (!latestTask) {
          unsubscribe()
          close()
          return
        }
        if (isTerminalState(latestTask.status.state)) {
          emitTerminal(latestTask, unsubscribe)
        }
      }, 50)
    },
  })
}

// ============================================================================
// Message Handler Logic
// ============================================================================

async function handleSendMessage(
  agentId: string,
  _agent: A2AAgent,
  req: SendMessageRequest,
  blocking: boolean,
): Promise<A2ATask> {
  // 1. Validate request
  if (!req.message.messageId) {
    throw new Error("message.messageId is required")
  }
  if (req.message.role !== "ROLE_USER") {
    throw new Error("message.role must be ROLE_USER")
  }
  if (!req.message.parts || req.message.parts.length === 0) {
    throw new Error("message.parts must have at least one part")
  }

  // 2. Create task
  const task: A2ATask = {
    id: generateUUID(),
    contextId: req.contextId || generateUUID(),
    agentId,
    status: { state: "TASK_STATE_SUBMITTED" },
    artifacts: [],
    history: [req.message],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  setTask(task)

  // 3. Extract prompt from message parts
  const prompt = req.message.parts
    .filter((p): p is { text: string } => "text" in p)
    .map((p) => p.text)
    .join("\n")
  const model = resolveModel(req.configuration)

  // 4. Create OpenCode session
  try {
    const session = await Session.create({})
    task.sessionId = session.id
    transitionTask(task, "TASK_STATE_WORKING", "Processing request...")

    // 5. Subscribe to session status updates
    const unsubscribe = subscribeTaskLifecycle(task, agentId, session.id)

    // 6. Send prompt to session
    SessionPrompt.prompt({
      sessionID: session.id,
      agent: agentId,
      model,
      parts: [{ type: "text", text: prompt }],
    }).catch((error) => {
      log.error("A2A session prompt failed", { taskId: task.id })
      if (isTerminalState(task.status.state)) return
      transitionTask(task, "TASK_STATE_FAILED", sanitizeFailureMessage("Session prompt failed"))
      unsubscribe()
    })

    // 7. If blocking, wait for completion
    if (blocking) {
      const timeout = req.configuration?.timeout || 300000 // 5 min default
      const start = Date.now()
      while (!isTerminalState(task.status.state)) {
        if (Date.now() - start > timeout) {
          transitionTask(task, "TASK_STATE_FAILED", "Request timed out")
          unsubscribe()
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
  } catch (error) {
    log.error("A2A session creation failed", { taskId: task.id })
    transitionTask(task, "TASK_STATE_FAILED", sanitizeFailureMessage("Failed to create session"))
  }

  return task
}

async function handleCancelTask(taskId: string): Promise<A2ATask | undefined> {
  const task = getTask(taskId)
  if (!task) return undefined

  if (isTerminalState(task.status.state)) {
    return task // Already terminal, idempotent
  }

  // Cancel the OpenCode session if running
  if (task.sessionId) {
    try {
      SessionPrompt.cancel(task.sessionId)
    } catch (error) {
      log.warn("Failed to cancel session", { error, sessionId: task.sessionId })
    }
  }

  transitionTask(task, "TASK_STATE_CANCELED", "Task canceled by client")
  return task
}

export const A2APlugin: Plugin = async () => {
  const config = await Config.get()
  const a2a = config.server?.a2a
  if (!a2a?.enabled) return {}

  recoverTasks()

  const serverConfig = {
    baseUrl: a2a.baseUrl,
    auth: a2a.auth,
    securitySchemes: a2a.securitySchemes,
  }

  const serverAuthz = (a2a as any).authz as
    | {
        provider?: "ext_authz" | "plugin"
        extAuthz?: import("../server/ext-authz").ExtAuthzConfig
        exposeDenyReason?: boolean
        plugin?: {
          id: string
          policy: Record<string, unknown>
          statusOnError?: number
        }
      }
    | undefined

  const serverExtAuthz =
    serverAuthz?.provider === "plugin"
      ? undefined
      : (serverAuthz?.extAuthz as import("../server/ext-authz").ExtAuthzConfig | undefined)

  const serverPluginAuthz =
    serverAuthz?.provider === "plugin" && serverAuthz.plugin?.id
      ? {
          id: serverAuthz.plugin.id,
          policy: serverAuthz.plugin.policy ?? {},
          statusOnError: serverAuthz.plugin.statusOnError,
        }
      : undefined

  const serverExposeDenyReason = serverAuthz?.exposeDenyReason ?? false

  function denyMessage(expose: boolean, reason?: string) {
    if (!expose) return "Authorization denied"
    if (!reason) return "Authorization denied"
    return reason
  }

  // Eagerly load the ext_authz module once at init time if configured,
  // so hot-path handlers don't pay the dynamic import cost per request.
  const extAuthzModule = serverExtAuthz ? await import("../server/ext-authz") : undefined

  const agents = await discoverA2AAgents(serverConfig)
  const byID = new Map(agents.map((agent) => [agent.id, agent]))

  log.info("A2A plugin initialized", {
    agents: agents.map((a) => a.id),
    skillCounts: agents.map((a) => ({ agent: a.id, skills: a.skills.length })),
  })

  /**
   * Check per-agent auth strategies. Returns the authentication result including
   * the caller's principal identity. Agent auth config replaces server-level auth
   * (not additive).
   */
  async function checkAgentAuth(strategies: AuthStrategy[], headers: Headers, agentId: string): Promise<AuthnResult> {
    if (strategies.length === 0) return { ok: true, strategy: "none", principal: "" } // No auth required (public agent)

    for (const strategy of strategies) {
      if (strategy === "api-key") {
        if (validA2AApiKey(headers)) return { ok: true, strategy: "api-key", principal: "api-key" }
        continue
      }
      if (strategy === "plugin") continue // Enforced by plugin hooks, not here

      // SPIFFE JWT-SVID with per-agent config override
      if (strategy === "spiffe") {
        const token = bearerFromHeaders(headers)
        if (!token) continue

        try {
          // Get per-agent SPIFFE config
          const agentConfig = await Agent.get(agentId)
          const spiffeConfig = (agentConfig?.a2a as any)?.spiffe as
            | { trustDomain?: string; audience?: string; allowedIds?: string[] }
            | undefined

          // Audience: per-agent override or global env var
          const audience = spiffeConfig?.audience ?? process.env["OPENCODE_SPIFFE_AUDIENCE"]
          if (!audience) continue

          // Allowed IDs: per-agent override or global env var
          const allowedIds =
            spiffeConfig?.allowedIds ??
            process.env["OPENCODE_SPIFFE_ALLOWED_IDS"]
              ?.split(",")
              .map((s) => s.trim())
              .filter(Boolean)

          const { verifySPIFFE } = await import("../server/spiffe")
          const spiffeId = await verifySPIFFE(token, audience, allowedIds)
          if (spiffeId) return { ok: true, strategy: "spiffe", principal: spiffeId }
        } catch (error) {
          // SPIFFE verification errors should fail closed (deny auth)
          // This includes SPIRE Agent unavailability, validation failures, etc.
          continue
        }
        continue
      }

      // jwt, oidc, oauth2
      const token = bearerFromHeaders(headers)
      if (!token) continue
      const result = await verifyBearerForStrategy(strategy as StrictBearerStrategy, token, {
        surface: "a2a",
        route: `a2a.${agentId}` as any,
        source: "centralized",
      })
      if (typeof result === "object" && result?.sub) {
        return { ok: true, strategy: strategy as any, principal: result.sub }
      }
    }
    return { ok: false, strategy: "none", principal: "" }
  }

  /**
   * Resolve the ext_authz config for an agent: per-agent override > server-level > none.
   */
  async function resolveAuthzConfig(agentId: string): Promise<
    | {
        provider: "ext_authz"
        extAuthz: import("../server/ext-authz").ExtAuthzConfig
        exposeDenyReason: boolean
      }
    | {
        provider: "plugin"
        exposeDenyReason: boolean
        plugin: {
          id: string
          policy: Record<string, unknown>
          statusOnError?: number
        }
      }
    | {
        provider: "error"
        reason: string
      }
    | undefined
  > {
    try {
      const agentConfig = await Agent.get(agentId)
      const perAgentAuthz = (agentConfig?.a2a as any)?.authz as
        | {
            provider?: "ext_authz" | "plugin"
            extAuthz?: import("../server/ext-authz").ExtAuthzConfig
            exposeDenyReason?: boolean
            plugin?: {
              id: string
              policy: Record<string, unknown>
              statusOnError?: number
            }
          }
        | undefined
      if (perAgentAuthz?.provider === "plugin" && perAgentAuthz.plugin) {
        return {
          provider: "plugin",
          exposeDenyReason: perAgentAuthz.exposeDenyReason ?? serverExposeDenyReason,
          plugin: {
            id: perAgentAuthz.plugin.id,
            policy: perAgentAuthz.plugin.policy,
            statusOnError: perAgentAuthz.plugin.statusOnError,
          },
        }
      }
      if (perAgentAuthz?.provider === "ext_authz" && perAgentAuthz.extAuthz) {
        return {
          provider: "ext_authz",
          exposeDenyReason: perAgentAuthz.exposeDenyReason ?? serverExposeDenyReason,
          extAuthz: perAgentAuthz.extAuthz,
        }
      }
      if (!perAgentAuthz?.provider && perAgentAuthz?.extAuthz) {
        return {
          provider: "ext_authz",
          exposeDenyReason: perAgentAuthz.exposeDenyReason ?? serverExposeDenyReason,
          extAuthz: perAgentAuthz.extAuthz,
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return {
        provider: "error",
        reason: `a2a_authz_config_error: ${reason}`,
      }
    }
    if (serverPluginAuthz) {
      return {
        provider: "plugin",
        exposeDenyReason: serverExposeDenyReason,
        plugin: {
          id: serverPluginAuthz.id,
          policy: serverPluginAuthz.policy,
          statusOnError: serverPluginAuthz.statusOnError,
        },
      }
    }
    if (serverExtAuthz) {
      return {
        provider: "ext_authz",
        exposeDenyReason: serverExposeDenyReason,
        extAuthz: serverExtAuthz,
      }
    }
    return undefined
  }

  async function runPluginAuthz(
    req: Request,
    agentId: string,
    authn: AuthnResult,
    action: "invoke" | "view",
    pluginAuthz: { id: string; policy: Record<string, unknown>; statusOnError?: number },
  ): Promise<A2AAuthzDecision | undefined> {
    const hookTimeoutMs = (() => {
      const raw = process.env["OPENCODE_A2A_PLUGIN_AUTHZ_TIMEOUT_MS"]
      const value = Number(raw)
      return Number.isFinite(value) && value > 0 ? Math.floor(value) : 5000
    })()
    const workload_principal = await (async () => {
      if (authn.strategy === "spiffe" && authn.principal.startsWith("spiffe://")) return authn.principal
      if (process.env["OPENCODE_A2A_TRUST_WORKLOAD_HEADER"] === "true") {
        const header = req.headers.get("x-opencode-workload")?.trim()
        if (!header) return undefined
        const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : header
        if (!token) return undefined
        const agentConfig = await Agent.get(agentId)
        const spiffeConfig = (agentConfig?.a2a as any)?.spiffe as
          | { trustDomain?: string; audience?: string; allowedIds?: string[] }
          | undefined
        const audience = spiffeConfig?.audience ?? process.env["OPENCODE_SPIFFE_AUDIENCE"]
        const allowedIds =
          spiffeConfig?.allowedIds ??
          process.env["OPENCODE_SPIFFE_ALLOWED_IDS"]
            ?.split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        if (audience && (!allowedIds || allowedIds.length === 0)) {
          log.warn("trusted workload header ignored: no OPENCODE_SPIFFE_ALLOWED_IDS configured", {
            agentId,
            audience,
          })
          return undefined
        }
        if (audience && allowedIds && allowedIds.length > 0) {
          const { verifySPIFFE } = await import("../server/spiffe")
          const spiffeId = await verifySPIFFE(token, audience, allowedIds)
          if (spiffeId) return spiffeId
          log.warn("trusted workload header token failed SPIFFE verification", {
            agentId,
            audience,
          })
        }

        const jwtAllow = process.env["OPENCODE_WORKLOAD_JWT_ALLOWED_SUBS"]
          ?.split(",")
          .map((s) => s.trim())
          .filter(Boolean)
        if (!jwtAllow || jwtAllow.length === 0) {
          log.warn("trusted workload header ignored: no OPENCODE_WORKLOAD_JWT_ALLOWED_SUBS configured", {
            agentId,
          })
          return undefined
        }
        const workloadIssuer = process.env["OPENCODE_WORKLOAD_JWT_ISSUER"]?.trim() || undefined
        const workloadAudienceRaw = process.env["OPENCODE_WORKLOAD_JWT_AUDIENCE"]
        const workloadAudience = workloadAudienceRaw
          ?.split(",")
          .map((s) => s.trim())
          .filter(Boolean)
        const verified = await verifyBearerForStrategy("jwt", token, {
          surface: "a2a",
          route: `a2a.${agentId}` as any,
          source: "centralized",
        }, {
          jwt: {
            issuer: workloadIssuer,
            audience: workloadAudience && workloadAudience.length > 0 ? workloadAudience : null,
          },
        })
        if (typeof verified !== "object" || !verified?.sub) {
          log.warn("trusted workload header token failed JWT verification", {
            agentId,
          })
          return undefined
        }
        if (!jwtAllow.includes(verified.sub)) {
          log.warn("trusted workload header ignored: jwt workload sub not allowlisted", {
            agentId,
          })
          return undefined
        }
        return verified.sub
      }
      return undefined
    })()

    const input = {
      agent: agentId,
      action,
      method: req.method,
      path: parsePath(req.url),
      headers: sanitizeHeaders(req.headers),
      strategy: authn.strategy,
      principal: authn.principal,
      user_principal: authn.principal,
      workload_principal,
      plugin: {
        id: pluginAuthz.id,
        policy: pluginAuthz.policy,
      },
    }

    try {
      const output = await Promise.race([
        Plugins.trigger("a2a.authz", input, { decision: undefined as A2AAuthzDecision | undefined }),
        new Promise<{ decision: A2AAuthzDecision | undefined }>((_, reject) =>
          setTimeout(() => reject(new Error(`a2a_authz_hook_timeout:${hookTimeoutMs}`)), hookTimeoutMs),
        ),
      ])
      if (!output.decision) return undefined
      if (typeof output.decision.allow !== "boolean") {
        return {
          allow: false,
          reason: "a2a_authz_malformed_decision",
          status_code: mapA2AAuthzStatus(pluginAuthz.statusOnError, true),
        }
      }
      return output.decision
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        allow: false,
        reason: `a2a_authz_hook_error: ${message}`,
        status_code: mapA2AAuthzStatus(pluginAuthz.statusOnError, true),
      }
    }
  }

  /**
   * Agent lookup and auth handler. Validates agent exists and enforces per-agent auth,
   * then runs ext_authz if configured.
   * Returns an error response if agent not found or auth/authz fails.
   * On success returns `undefined` and attaches the `AuthnResult` to the request
   * via the `_authnResult` map so downstream handlers can access the caller identity.
   */
  const _authnResults = new WeakMap<Request, AuthnResult>()

  async function agentHandler(params: Record<string, string>, req: Request): Promise<Response | undefined> {
    const agentId = params.agent
    if (!agentId) return json({ error: { code: "BadRequest", message: "Missing agent ID" } }, 400)
    const agent = byID.get(agentId)
    if (!agent) return json({ error: { code: "NotFound", message: `Unknown agent: ${agentId}` } }, 404)

    // Step 1: Authentication (who are you?)
    const authn = await checkAgentAuth(agent.auth, req.headers, agentId)
    if (!authn.ok) {
      return json({ error: { code: "Unauthorized", message: "Authentication required" } }, 401)
    }

    // Stash the authn result so ext_authz and handlers can access the caller identity
    _authnResults.set(req, authn)

    // Step 2: Authorization (ext_authz or plugin)
    const authzConfig = await resolveAuthzConfig(agentId)
    if (authzConfig?.provider === "error") {
      log.warn("authz config resolution failed", { agentId, reason: authzConfig.reason })
      return json({ error: { code: "Forbidden", message: "Authorization denied" } }, 403)
    }
    if (authzConfig?.provider === "ext_authz") {
      const extAuthzConfig = authzConfig.extAuthz
      try {
        // Use eagerly-loaded module if available, fall back to dynamic import
        // (per-agent config may enable ext_authz even when server-level is off)
        const mod = extAuthzModule ?? (await import("../server/ext-authz"))
        const context = mod.requestToExtAuthzContext(req, {
          agentId,
          authStrategy: authn.strategy,
        })
        const decision = await mod.checkAuthorization(extAuthzConfig, context, authn)

        if (!decision.allowed) {
          log.warn("ext_authz denied request", {
            agentId,
            principal: authn.principal,
            reason: decision.reason,
            latencyMs: decision.latencyMs,
          })
          emitAuthDecision({
            surface: "a2a",
            route: "a2a.protected",
            outcome: "deny",
            strategy: "ext_authz",
            reason: decision.reason.includes("timeout") ? "ext_authz_timeout" : "ext_authz_denied",
          })
          const statusCode = mapA2AAuthzStatus(decision.statusCode, true)
          return json(
            {
              error: {
                code: "Forbidden",
                message: denyMessage(authzConfig.exposeDenyReason, decision.reason),
              },
            },
            statusCode,
          )
        }

        emitAuthDecision({
          surface: "a2a",
          route: "a2a.protected",
          outcome: "allow",
          strategy: "ext_authz",
          reason: "none",
        })

        log.debug("ext_authz allowed request", {
          agentId,
          principal: authn.principal,
          latencyMs: decision.latencyMs,
        })
      } catch (error) {
        // ext_authz module failed to load or unexpected error
        const message = error instanceof Error ? error.message : String(error)
        log.error("ext_authz unexpected error", { error: message, agentId })

        emitAuthDecision({
          surface: "a2a",
          route: "a2a.protected",
          outcome: extAuthzConfig.failOpen ? "allow" : "deny",
          strategy: "ext_authz",
          reason: "ext_authz_error",
        })

        // Fail-closed unless failOpen is configured
        if (!extAuthzConfig.failOpen) {
          return json(
            { error: { code: "Forbidden", message: "Authorization denied" } },
            mapA2AAuthzStatus(extAuthzConfig.statusOnError, true),
          )
        }
      }
    }

    if (authzConfig?.provider === "plugin") {
      const decision = await runPluginAuthz(req, agentId, authn, "invoke", authzConfig.plugin)
      if (!decision || !decision.allow) {
        const reason = decision?.reason ?? "a2a_authz_no_decision"
        log.warn("plugin authz denied request", {
          agentId,
          principal: authn.principal,
          reason,
        })
        const statusCode = mapA2AAuthzStatus(decision?.status_code, true)
        return json(
          {
            error: {
              code: "Forbidden",
              message: denyMessage(authzConfig.exposeDenyReason, reason),
            },
          },
          statusCode,
        )
      }
    }

    return undefined // Agent exists, auth+authz passed, continue to handler
  }

  /** Get the authentication result for a request (populated by agentHandler). */
  function getAuthnResult(req: Request): AuthnResult | undefined {
    return _authnResults.get(req)
  }

  /**
   * Attempt to authenticate the caller without requiring auth.
   * Used by discovery routes: if credentials are present and valid, return the
   * AuthnResult; if no credentials or invalid, return undefined (not an error).
   * Uses the server-level auth strategies since discovery is not per-agent.
   */
  async function tryAuthenticate(headers: Headers): Promise<AuthnResult | undefined> {
    const strategies = asArray(serverConfig.auth as AuthStrategy | AuthStrategy[] | undefined)
    if (strategies.length === 0) return undefined

    for (const strategy of strategies) {
      if (strategy === "api-key") {
        if (validA2AApiKey(headers)) return { ok: true, strategy: "api-key", principal: "api-key" }
        continue
      }
      if (strategy === "plugin") continue

      if (strategy === "spiffe") {
        const token = bearerFromHeaders(headers)
        if (!token) continue
        try {
          const audience = process.env["OPENCODE_SPIFFE_AUDIENCE"]
          if (!audience) continue
          const allowedIds = process.env["OPENCODE_SPIFFE_ALLOWED_IDS"]
            ?.split(",")
            .map((s) => s.trim())
            .filter(Boolean)
          const { verifySPIFFE } = await import("../server/spiffe")
          const spiffeId = await verifySPIFFE(token, audience, allowedIds)
          if (spiffeId) return { ok: true, strategy: "spiffe", principal: spiffeId }
        } catch (error) {
          log.debug("tryAuthenticate: spiffe verification failed", {
            error: error instanceof Error ? error.message : String(error),
          })
          continue
        }
        continue
      }

      // jwt, oidc, oauth2
      const token = bearerFromHeaders(headers)
      if (!token) continue
      const result = await verifyBearerForStrategy(strategy as StrictBearerStrategy, token, {
        surface: "a2a",
        route: "a2a.discovery" as any,
        source: "centralized",
      })
      if (typeof result === "object" && result?.sub) {
        return { ok: true, strategy: strategy as any, principal: result.sub }
      }
    }
    return undefined
  }

  /**
   * Filter agents by ext_authz "view" permission.
   *
   * If ext_authz is not configured, all agents are visible.
   * If ext_authz is configured but the caller is unauthenticated, no agents are
   * visible (fail-closed — we cannot determine the caller's identity).
   * If ext_authz is configured and the caller is authenticated, check the "view"
   * permission for each agent and return only the visible ones.
   *
   * The ext_authz call uses skill="view" in context_extensions, which the adapter
   * maps to the SpiceDB `view` permission (backed by the `viewer` relation).
   */
  /** Aggregate timeout for all ext_authz view checks in a single discovery request. */
  const DISCOVERY_AUTHZ_TIMEOUT_MS = 10_000

  /**
   * Minimum response time for discovery endpoints when ext_authz is configured.
   * Pads responses to a constant floor to prevent timing side channels that
   * could reveal the total agent count to unauthorized callers.
   * Set to 0 to disable (or via OPENCODE_DISCOVERY_MIN_LATENCY_MS env var).
   */
  const DISCOVERY_MIN_LATENCY_MS = parseInt(process.env.OPENCODE_DISCOVERY_MIN_LATENCY_MS ?? "150", 10)

  /** Pad execution to a constant time floor. Eliminates timing side channels. */
  async function withConstantTime<T>(startTime: number, fn: () => Promise<T>): Promise<T> {
    const result = await fn()
    if (DISCOVERY_MIN_LATENCY_MS > 0) {
      const elapsed = Date.now() - startTime
      const remaining = DISCOVERY_MIN_LATENCY_MS - elapsed
      if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, remaining))
      }
    }
    return result
  }

  // -----------------------------------------------------------------------
  // Discovery authz cache: short-TTL in-memory cache keyed on
  // (principal, agentId, permission). Reduces repeated ext_authz calls when
  // multiple discovery endpoints are hit in quick succession (e.g. listing
  // followed by individual card requests).
  // -----------------------------------------------------------------------
  const DISCOVERY_CACHE_TTL_MS = 30_000 // 30 seconds
  const DISCOVERY_CACHE_MAX_SIZE = 1000
  const PER_AGENT_AUTHZ_CACHE_TTL_MS = 30_000

  type CacheEntry = { allowed: boolean; expiresAt: number }
  const discoveryCache = new Map<string, CacheEntry>()
  let hasPerAgentAuthzCache: { value: boolean; expiresAt: number } | undefined

  function cacheKey(principal: string, agentId: string, permission: string): string {
    return `${principal}\0${agentId}\0${permission}`
  }

  function cacheGet(principal: string, agentId: string, permission: string): boolean | undefined {
    const key = cacheKey(principal, agentId, permission)
    const entry = discoveryCache.get(key)
    if (!entry) return undefined
    if (Date.now() > entry.expiresAt) {
      discoveryCache.delete(key)
      return undefined
    }
    return entry.allowed
  }

  function cacheSet(principal: string, agentId: string, permission: string, allowed: boolean): void {
    // Simple eviction: if cache is full, clear it (entries are short-lived anyway)
    if (discoveryCache.size >= DISCOVERY_CACHE_MAX_SIZE) {
      const now = Date.now()
      for (const [k, v] of discoveryCache) {
        if (now > v.expiresAt) discoveryCache.delete(k)
      }
      // If still full after expiry sweep, clear entirely
      if (discoveryCache.size >= DISCOVERY_CACHE_MAX_SIZE) discoveryCache.clear()
    }
    discoveryCache.set(cacheKey(principal, agentId, permission), {
      allowed,
      expiresAt: Date.now() + DISCOVERY_CACHE_TTL_MS,
    })
  }

  async function hasAnyPerAgentAuthz(): Promise<boolean> {
    if (hasPerAgentAuthzCache && Date.now() < hasPerAgentAuthzCache.expiresAt) return hasPerAgentAuthzCache.value
    const checks = await Promise.all(
      agents.map(async (agent) => {
        try {
          const agentConfig = await Agent.get(agent.id)
          const authz = ((agentConfig?.a2a as any)?.authz as any) ?? undefined
          if (!authz || typeof authz !== "object") return false
          if (authz.provider === "plugin" && authz.plugin) return true
          if (authz.provider === "ext_authz" && authz.extAuthz) return true
          if (!authz.provider && authz.extAuthz) return true
          return false
        } catch {
          return true
        }
      }),
    )
    const value = checks.some(Boolean)
    hasPerAgentAuthzCache = {
      value,
      expiresAt: Date.now() + PER_AGENT_AUTHZ_CACHE_TTL_MS,
    }
    return value
  }

  async function filterVisibleAgents(req: Request): Promise<A2AAgent[]> {
    if (!serverExtAuthz && !serverPluginAuthz) {
      if (!(await hasAnyPerAgentAuthz())) return agents
      const authn = await tryAuthenticate(req.headers)
      if (!authn) return []
      const visible = await Promise.all(
        agents.map(async (agent) => ((await canViewAgent(req, agent.id)) ? agent : undefined)),
      )
      return visible.filter((item): item is A2AAgent => !!item)
    }

    if (serverPluginAuthz) {
      const authn = await tryAuthenticate(req.headers)
      if (!authn) return []
      const visible = await Promise.all(
        agents.map(async (agent) => ((await canViewAgent(req, agent.id)) ? agent : undefined)),
      )
      return visible.filter((item): item is A2AAgent => !!item)
    }

    const startTime = Date.now()
    return withConstantTime(startTime, async () => {
      // Try to authenticate the caller (optional — no credentials is not an error)
      const authn = await tryAuthenticate(req.headers)

      // If ext_authz is configured but caller is unauthenticated, fail-closed: hide all agents
      if (!authn) {
        log.debug("discovery: no credentials provided, hiding all agents (ext_authz configured)")
        return []
      }

      // Check "view" permission for each agent. First check cache, then try
      // batch for uncached agents (single RPC), fall back to parallel individual checks.
      try {
        const mod = extAuthzModule ?? (await import("../server/ext-authz"))
        const principal = authn.principal

        // --- Phase 1: Check cache for all agents ---
        const cached: A2AAgent[] = []
        const uncached: A2AAgent[] = []
        for (const agent of agents) {
          const hit = cacheGet(principal, agent.id, "view")
          if (hit !== undefined) {
            if (hit) cached.push(agent)
            // hit === false means cached deny — skip agent
          } else {
            uncached.push(agent)
          }
        }

        // If all agents were cached, return immediately
        if (uncached.length === 0) {
          log.debug("discovery: all agents resolved from cache", {
            total: agents.length,
            visible: cached.length,
            principal,
          })
          return cached
        }

        // --- Phase 2: Attempt batch check for uncached agents ---
        const allUseServerConfig = (
          await Promise.all(
            uncached.map(async (a) => {
              try {
                const cfg = await Agent.get(a.id)
                const authz = ((cfg?.a2a as any)?.authz as any) ?? undefined
                return !authz
              } catch {
                return false
              }
            }),
          )
        ).every(Boolean)
        let batchResolved = false

        if (allUseServerConfig && mod.batchCheckAuthorization && serverExtAuthz) {
          try {
            const items = uncached.map((a) => ({ agentId: a.id, permission: "view" }))

            const batchPromise = mod.batchCheckAuthorization(serverExtAuthz, principal, items)
            const timeoutPromise = new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("batch discovery authz timeout")), DISCOVERY_AUTHZ_TIMEOUT_MS),
            )

            const batchResults = await Promise.race([batchPromise, timeoutPromise])

            const resultMap = new Map(batchResults.map((r: any) => [r.agentId, r]))
            const failOpen = serverExtAuthz?.failOpen ?? false

            for (const agent of uncached) {
              const result = resultMap.get(agent.id)
              if (!result) {
                if (failOpen) cached.push(agent)
                else log.warn("discovery: batch missing result for agent", { agentId: agent.id })
                continue
              }
              if (result.error) {
                log.warn("discovery: batch check error for agent", { agentId: agent.id, error: result.error, failOpen })
                if (failOpen) cached.push(agent)
                // Don't cache errors
              } else {
                cacheSet(principal, agent.id, "view", result.allowed)
                if (result.allowed) cached.push(agent)
              }
            }

            batchResolved = true
            log.debug("discovery: batch-filtered agents", {
              total: agents.length,
              fromCache: agents.length - uncached.length,
              batchChecked: uncached.length,
              visible: cached.length,
              principal,
            })
          } catch (batchErr) {
            log.debug("discovery: batch authz unavailable, falling back to individual checks", {
              error: batchErr instanceof Error ? batchErr.message : String(batchErr),
            })
          }
        }

        if (batchResolved) return cached

        // --- Phase 3: Fall back to parallel individual checks ---
        type ViewResult = {
          agent: A2AAgent
          allowed: boolean
          error?: string
          failOpen: boolean
          latencyMs?: number
        }

        const checksPromise = Promise.all(
          uncached.map(async (agent): Promise<ViewResult> => {
            const agentAuthz = await resolveAuthzConfig(agent.id)
            if (agentAuthz?.provider === "error") {
              return {
                agent,
                allowed: false,
                error: agentAuthz.reason,
                failOpen: false,
              }
            }
            if (agentAuthz?.provider === "plugin") {
              try {
                const decision = await runPluginAuthz(req, agent.id, authn, "view", agentAuthz.plugin)
                return { agent, allowed: decision?.allow === true, failOpen: false }
              } catch (err) {
                return {
                  agent,
                  allowed: false,
                  error: err instanceof Error ? err.message : String(err),
                  failOpen: false,
                }
              }
            }
            const extAuthzConfig =
              (agentAuthz?.provider === "ext_authz" ? agentAuthz.extAuthz : undefined) ?? serverExtAuthz!
            const failOpen = extAuthzConfig.failOpen ?? false
            try {
              const context = mod.requestToExtAuthzContext(req, {
                agentId: agent.id,
                skill: "view",
                authStrategy: authn.strategy,
              })
              const decision = await mod.checkAuthorization(extAuthzConfig, context, authn)
              return { agent, allowed: decision.allowed, latencyMs: decision.latencyMs, failOpen }
            } catch (err) {
              return { agent, allowed: failOpen, error: err instanceof Error ? err.message : String(err), failOpen }
            }
          }),
        )

        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("discovery authz timeout")), DISCOVERY_AUTHZ_TIMEOUT_MS),
        )

        const results = await Promise.race([checksPromise, timeoutPromise])

        for (const result of results) {
          if (result.error) {
            log.warn("discovery: ext_authz check failed for agent", {
              agentId: result.agent.id,
              error: result.error,
              failOpen: result.failOpen,
              allowed: result.allowed,
            })
            // Don't cache errors
          } else {
            cacheSet(principal, result.agent.id, "view", result.allowed)
          }
          if (result.allowed) {
            cached.push(result.agent)
          } else if (!result.error) {
            log.debug("discovery: agent hidden by ext_authz", {
              agentId: result.agent.id,
              principal,
              latencyMs: result.latencyMs,
            })
          }
        }

        log.debug("discovery: filtered agents", {
          total: agents.length,
          fromCache: agents.length - uncached.length,
          checked: uncached.length,
          visible: cached.length,
          principal,
        })

        return cached
      } catch (error) {
        // ext_authz module failed to load or aggregate timeout — respect failOpen
        const message = error instanceof Error ? error.message : String(error)
        log.error("discovery: ext_authz error, applying failOpen policy", { error: message })
        const visible = await Promise.all(
          agents.map(async (agent) => ((await canViewAgent(req, agent.id)) ? agent : undefined)),
        )
        return visible.filter((item): item is A2AAgent => !!item)
      }
    }) // end withConstantTime
  }

  /**
   * Check ext_authz "view" permission for a single agent.
   * Returns true if visible, false if hidden.
   */
  async function canViewAgent(req: Request, agentId: string): Promise<boolean> {
    const authzConfig = await resolveAuthzConfig(agentId)
    if (authzConfig?.provider === "error") return false
    if (!authzConfig) return true

    const authn = await tryAuthenticate(req.headers)
    if (!authn) return false

    if (authzConfig.provider === "plugin") {
      const decision = await runPluginAuthz(req, agentId, authn, "view", authzConfig.plugin)
      if (!decision) return false
      return decision.allow === true
    }

    const extAuthzConfig = authzConfig.extAuthz

    // Check cache first
    const hit = cacheGet(authn.principal, agentId, "view")
    if (hit !== undefined) return hit

    try {
      const mod = extAuthzModule ?? (await import("../server/ext-authz"))
      const context = mod.requestToExtAuthzContext(req, {
        agentId,
        skill: "view",
        authStrategy: authn.strategy,
      })
      const decision = await mod.checkAuthorization(extAuthzConfig, context, authn)
      cacheSet(authn.principal, agentId, "view", decision.allowed)
      return decision.allowed
    } catch {
      // Don't cache errors
      return extAuthzConfig.failOpen ?? false
    }
  }

  const messageStreamHandler = async (req: Request, params: Record<string, string>) => {
    // Validate A2A version
    const versionErr = validateA2AVersion(req)
    if (versionErr) return addA2AVersionHeader(versionErr)

    const agentErr = await agentHandler(params, req)
    if (agentErr) return addA2AVersionHeader(agentErr)

    const agentId = params.agent
    const agent = byID.get(agentId)!

    try {
      const body = (await req.json()) as SendMessageRequest

      // Create task (non-blocking)
      const task = await handleSendMessage(agentId, agent, body, false)

      const stream = taskEventStream(task)

      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "A2A-Version": A2A_VERSION,
        },
      })
    } catch (error: any) {
      log.error("message:stream failed", { error, agentId })
      return addA2AVersionHeader(a2aError(-32600, error.message || "Invalid request"))
    }
  }

  const cancelTaskHandler = async (req: Request, params: Record<string, string>) => {
    try {
      const agentErr = await agentHandler(params, req)
      if (agentErr) return addA2AVersionHeader(agentErr)

      const taskId = params.id
      const task = getTask(taskId)

      if (!task) {
        return addA2AVersionHeader(json({ error: { code: "NotFound", message: `Task not found: ${taskId}` } }, 404))
      }

      // Verify task belongs to this agent
      if (task.agentId !== params.agent) {
        return addA2AVersionHeader(json({ error: { code: "NotFound", message: `Task not found: ${taskId}` } }, 404))
      }

      const canceledTask = await handleCancelTask(taskId)
      return addA2AVersionHeader(json(taskResponse(canceledTask!)))
    } catch (error: any) {
      log.error("tasks/:id:cancel failed", { error, path: req.url })
      return addA2AVersionHeader(
        json({ error: { code: "InternalError", message: error.message || "Internal server error" } }, 500),
      )
    }
  }

  const subscribeTaskHandler = async (req: Request, params: Record<string, string>) => {
    try {
      const agentErr = await agentHandler(params, req)
      if (agentErr) return addA2AVersionHeader(agentErr)

      const taskId = params.id
      const task = getTask(taskId)

      if (!task) {
        return addA2AVersionHeader(json({ error: { code: "NotFound", message: `Task not found: ${taskId}` } }, 404))
      }

      // Verify task belongs to this agent
      if (task.agentId !== params.agent) {
        return addA2AVersionHeader(json({ error: { code: "NotFound", message: `Task not found: ${taskId}` } }, 404))
      }

      const stream = taskEventStream(task)

      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "A2A-Version": A2A_VERSION,
        },
      })
    } catch (error: any) {
      log.error("tasks/:id:subscribe failed", { error, path: req.url })
      return addA2AVersionHeader(
        json({ error: { code: "InternalError", message: error.message || "Internal server error" } }, 500),
      )
    }
  }

  const routes: RouteDefinition[] = [
    // Discovery: list A2A agents (authz-filtered when ext_authz is configured)
    // If ext_authz is configured, only agents the caller has "view" permission on
    // are returned. If the caller provides no credentials, an empty list is returned
    // (fail-closed). If ext_authz is not configured, all agents are visible.
    {
      method: "GET",
      path: "/.well-known/agents.json",
      auth: [],
      handler: async (req) => {
        const visible = await filterVisibleAgents(req)
        return json({
          agents: visible.map((a) => ({
            id: a.id,
            name: a.name,
            description: a.description,
            cardUrl: `/.well-known/agents/${a.id}/card.json`,
          })),
        })
      },
    },

    // Discovery: agent card for specific agent (authz-filtered)
    // Returns 404 if the agent doesn't exist OR the caller lacks "view" permission.
    // This prevents information leakage — unauthorized callers cannot distinguish
    // between "agent exists but I can't see it" and "agent doesn't exist".
    {
      method: "GET",
      path: "/.well-known/agents/:agent/card.json",
      auth: [],
      handler: async (req, params) => {
        const agentId = params.agent
        const agent = byID.get(agentId)
        if (!agent) return json({ error: { code: "NotFound", message: `Unknown agent: ${agentId}` } }, 404)

        if (!(await canViewAgent(req, agentId))) {
          // Return 404, not 403, to prevent information leakage
          return json({ error: { code: "NotFound", message: `Unknown agent: ${agentId}` } }, 404)
        }

        return json(generateAgentCard(agent))
      },
    },

    // Standard A2A discovery: single agent card (authz-filtered)
    // Per spec: /.well-known/agent-card.json
    // Also support /.well-known/a2a/agent-card for client compatibility (PR #10452)
    {
      method: "GET",
      path: "/.well-known/agent-card.json",
      auth: [],
      handler: async (req) => {
        const visible = await filterVisibleAgents(req)
        if (visible.length === 0) {
          return json({ error: { code: "NotFound", message: "No A2A agents configured" } }, 404)
        }
        // A2A spec §8.1: this endpoint MUST return an AgentCard.
        // When multiple agents are visible, return the first one's card.
        // Clients can use /.well-known/agents.json for the full listing.
        return json(generateAgentCard(visible[0]))
      },
    },

    // Client compatibility: /.well-known/a2a/agent-card (authz-filtered)
    {
      method: "GET",
      path: "/.well-known/a2a/agent-card",
      auth: [],
      handler: async (req) => {
        const visible = await filterVisibleAgents(req)
        if (visible.length === 0) {
          return json({ error: { code: "NotFound", message: "No A2A agents configured" } }, 404)
        }
        // A2A spec §8.1: this endpoint MUST return an AgentCard.
        // When multiple agents are visible, return the first one's card.
        return json(generateAgentCard(visible[0]))
      },
    },

    // Message: send to specific agent
    {
      method: "POST",
      path: "/a2a/:agent/message:send",
      auth: [],
      handler: async (req, params) => {
        // Validate A2A version
        const versionErr = validateA2AVersion(req)
        if (versionErr) return addA2AVersionHeader(versionErr)

        const agentErr = await agentHandler(params, req)
        if (agentErr) return addA2AVersionHeader(agentErr)

        const agentId = params.agent
        const agent = byID.get(agentId)!

        try {
          const body = (await req.json()) as SendMessageRequest
          const blocking = body.configuration?.blocking ?? false
          const task = await handleSendMessage(agentId, agent, body, blocking)
          return addA2AVersionHeader(json(taskResponse(task)))
        } catch (error: any) {
          log.error("message:send failed", { error, agentId })
          return addA2AVersionHeader(a2aError(-32600, error.message || "Invalid request"))
        }
      },
    },

    // Message: stream to specific agent
    {
      method: "POST",
      path: "/a2a/:agent/message:stream",
      auth: [],
      handler: messageStreamHandler,
    },

    // Compatibility alias for frameworks that do not support action suffix in path params
    {
      method: "POST",
      path: "/a2a/:agent/message/stream",
      auth: [],
      handler: messageStreamHandler,
    },

    // Tasks: get task by ID for specific agent
    {
      method: "GET",
      path: "/a2a/:agent/tasks/:id",
      auth: [],
      handler: async (req, params) => {
        try {
          const agentErr = await agentHandler(params, req)
          if (agentErr) return addA2AVersionHeader(agentErr)

          const taskId = params.id
          const task = getTask(taskId)

          if (!task) {
            return addA2AVersionHeader(json({ error: { code: "NotFound", message: `Task not found: ${taskId}` } }, 404))
          }

          // Verify task belongs to this agent
          if (task.agentId !== params.agent) {
            return addA2AVersionHeader(json({ error: { code: "NotFound", message: `Task not found: ${taskId}` } }, 404))
          }

          return addA2AVersionHeader(json(taskResponse(task)))
        } catch (error: any) {
          log.error("tasks/:id failed", { error, path: req.url })
          return addA2AVersionHeader(
            json({ error: { code: "InternalError", message: error.message || "Internal server error" } }, 500),
          )
        }
      },
    },

    // Tasks: list tasks for specific agent
    {
      method: "GET",
      path: "/a2a/:agent/tasks",
      auth: [],
      handler: async (req, params) => {
        try {
          const agentErr = await agentHandler(params, req)
          if (agentErr) return addA2AVersionHeader(agentErr)

          const agentId = params.agent
          const tasks = listTasks(agentId)

          return addA2AVersionHeader(
            json({
              tasks: tasks.map((t) => ({
                id: t.id,
                contextId: t.contextId,
                status: t.status,
              })),
            }),
          )
        } catch (error: any) {
          log.error("tasks list failed", { error, path: req.url })
          return addA2AVersionHeader(
            json({ error: { code: "InternalError", message: error.message || "Internal server error" } }, 500),
          )
        }
      },
    },

    // Tasks: cancel task for specific agent
    {
      method: "POST",
      path: "/a2a/:agent/tasks/:id:cancel",
      auth: [],
      handler: cancelTaskHandler,
    },

    // Compatibility alias for frameworks that do not support action suffix in path params
    {
      method: "POST",
      path: "/a2a/:agent/tasks/:id/cancel",
      auth: [],
      handler: cancelTaskHandler,
    },

    // Tasks: subscribe to task events for specific agent
    // Per A2A spec, SubscribeToTask uses GET (not POST)
    {
      method: "GET",
      path: "/a2a/:agent/tasks/:id:subscribe",
      auth: [],
      handler: subscribeTaskHandler,
    },

    // Compatibility alias for frameworks that do not support action suffix in path params
    {
      method: "GET",
      path: "/a2a/:agent/tasks/:id/subscribe",
      auth: [],
      handler: subscribeTaskHandler,
    },
  ]

  const result: Hooks = {
    "http.route": routes,
  }
  return result
}
