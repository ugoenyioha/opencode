import type { Hooks, Plugin, RouteDefinition, AuthStrategy } from "@opencode-ai/plugin"
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
// Auth is handled by server-level middleware in server.ts, not per-route.

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
// Task Storage (in-memory)
// ============================================================================

const taskStore = Instance.state(() => new Map<string, A2ATask>())

function generateUUID(): string {
  return crypto.randomUUID()
}

function getTask(taskId: string): A2ATask | undefined {
  return taskStore().get(taskId)
}

function setTask(task: A2ATask): void {
  task.updatedAt = Date.now()
  taskStore().set(task.id, task)
}

function listTasks(agentId?: string): A2ATask[] {
  const tasks = Array.from(taskStore().values())
  if (agentId) {
    return tasks.filter((t) => t.agentId === agentId)
  }
  return tasks
}

function isTerminalState(state: TaskState): boolean {
  return ["TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_CANCELED", "TASK_STATE_REJECTED"].includes(state)
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

function strategyType(strategy: AuthStrategy) {
  if (strategy === "api-key") return "apiKey"
  if (strategy === "jwt") return "http"
  if (strategy === "spiffe") return "mutualTls"
  if (strategy === "oauth2") return "oauth2"
  if (strategy === "oidc") return "oidc"
  return "plugin"
}

function json(input: unknown, status = 200) {
  return new Response(JSON.stringify(input), {
    status,
    headers: {
      "content-type": JSON_MIME,
    },
  })
}

function securityRequirements(
  auth: AuthStrategy[],
  schemes: Record<string, { type: "apiKey" | "http" | "mutualTls" | "oauth2" | "oidc" }>,
) {
  return auth
    .flatMap((entry) => {
      const type = strategyType(entry)
      if (type === "plugin") return []
      return Object.entries(schemes)
        .filter(([_, value]) => value.type === type)
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
      auth: asArray(a2aConfig.auth as AuthStrategy | AuthStrategy[] | undefined).length
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

// ============================================================================
// Message Handler Logic
// ============================================================================

async function handleSendMessage(
  agentId: string,
  agent: A2AAgent,
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

  // 4. Create OpenCode session
  try {
    const session = await Session.create({})
    task.sessionId = session.id
    task.status = { state: "TASK_STATE_WORKING", message: "Processing request..." }
    setTask(task)

    // 5. Subscribe to session status updates
    // Bus.subscribe callback receives { type, properties }
    const unsubscribe = Bus.subscribe(SessionStatus.Event.Status, async (event) => {
      try {
        if (event.properties.sessionID !== session.id) return

        if (event.properties.status.type === "idle") {
          // Session completed
          task.status = { state: "TASK_STATE_COMPLETED" }

          // Get session messages to extract output
          const messages = await Session.messages({ sessionID: session.id })
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

            // Add agent response to history
            task.history.push({
              messageId: lastAssistant.info.id,
              role: "ROLE_AGENT",
              parts: [{ text: textParts || "Task completed." }],
            })
          }

          setTask(task)
          unsubscribe()
        }
      } catch (error: any) {
        log.error("A2A session status handler failed", { error, taskId: task.id, sessionId: session.id })
        task.status = {
          state: "TASK_STATE_FAILED",
          message: error.message || "Internal error processing session status",
        }
        setTask(task)
        unsubscribe()
      }
    })

    // 6. Send prompt to session
    SessionPrompt.prompt({
      sessionID: session.id,
      agent: agentId,
      parts: [{ type: "text", text: prompt }],
    }).catch((error) => {
      log.error("A2A session prompt failed", { error, taskId: task.id })
      task.status = { state: "TASK_STATE_FAILED", message: error.message || "Session prompt failed" }
      setTask(task)
      unsubscribe()
    })

    // 7. If blocking, wait for completion
    if (blocking) {
      const timeout = req.configuration?.timeout || 300000 // 5 min default
      const start = Date.now()
      while (!isTerminalState(task.status.state)) {
        if (Date.now() - start > timeout) {
          task.status = { state: "TASK_STATE_FAILED", message: "Request timed out" }
          setTask(task)
          unsubscribe()
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
  } catch (error: any) {
    log.error("A2A session creation failed", { error, taskId: task.id })
    task.status = { state: "TASK_STATE_FAILED", message: error.message || "Failed to create session" }
    setTask(task)
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

  task.status = { state: "TASK_STATE_CANCELED", message: "Task canceled by client" }
  setTask(task)
  return task
}

export const A2APlugin: Plugin = async () => {
  const config = await Config.get()
  const a2a = config.server?.a2a
  if (!a2a?.enabled) return {}

  const serverConfig = {
    baseUrl: a2a.baseUrl,
    auth: a2a.auth,
    securitySchemes: a2a.securitySchemes,
  }

  const agents = await discoverA2AAgents(serverConfig)
  const byID = new Map(agents.map((agent) => [agent.id, agent]))

  log.info("A2A plugin initialized", {
    agents: agents.map((a) => a.id),
    skillCounts: agents.map((a) => ({ agent: a.id, skills: a.skills.length })),
  })

  // Agent lookup handler
  function agentHandler(params: Record<string, string>): Response | undefined {
    const agentId = params.agent
    if (!agentId) return json({ error: { code: "BadRequest", message: "Missing agent ID" } }, 400)
    if (!byID.has(agentId)) return json({ error: { code: "NotFound", message: `Unknown agent: ${agentId}` } }, 404)
    return undefined // Agent exists, continue to handler
  }

  // Auth is handled by server-level middleware (server.ts) which checks
  // OPENCODE_TOOL_ENDPOINT_API_KEY and OPENCODE_SERVER_PASSWORD as mutually
  // exclusive auth methods. Discovery routes opt out via `auth: []`.
  const protectedA2AAuthList = asArray(serverConfig.auth as AuthStrategy | AuthStrategy[] | undefined)
  const protectedA2AAuth = protectedA2AAuthList.length > 0 ? protectedA2AAuthList : undefined

  const routes: RouteDefinition[] = [
    // Discovery: list all A2A agents (public — no auth required)
    {
      method: "GET",
      path: "/.well-known/agents.json",
      auth: [],
      handler: async () =>
        json({
          agents: agents.map((a) => ({
            id: a.id,
            name: a.name,
            description: a.description,
            cardUrl: `/.well-known/agents/${a.id}/card.json`,
          })),
        }),
    },

    // Discovery: agent card for specific agent (public — no auth required)
    {
      method: "GET",
      path: "/.well-known/agents/:agent/card.json",
      auth: [],
      handler: async (_req, params) => {
        const agentId = params.agent
        const agent = byID.get(agentId)
        if (!agent) return json({ error: { code: "NotFound", message: `Unknown agent: ${agentId}` } }, 404)
        return json(generateAgentCard(agent))
      },
    },

    // Standard A2A discovery: single agent card (public — no auth required)
    // Per spec: /.well-known/agent-card.json
    // Also support /.well-known/a2a/agent-card for client compatibility (PR #10452)
    {
      method: "GET",
      path: "/.well-known/agent-card.json",
      auth: [],
      handler: async () => {
        if (agents.length === 0) {
          return json({ error: { code: "NotFound", message: "No A2A agents configured" } }, 404)
        }
        if (agents.length === 1) {
          return json(generateAgentCard(agents[0]))
        }
        // Multiple agents: return listing with card URLs
        return json({
          message: "Multiple A2A agents available. Use /.well-known/agents.json for listing.",
          agents: agents.map((a) => ({
            id: a.id,
            cardUrl: `/.well-known/agents/${a.id}/card.json`,
          })),
        })
      },
    },

    // Client compatibility: /.well-known/a2a/agent-card (public — no auth required)
    {
      method: "GET",
      path: "/.well-known/a2a/agent-card",
      auth: [],
      handler: async () => {
        if (agents.length === 0) {
          return json({ error: { code: "NotFound", message: "No A2A agents configured" } }, 404)
        }
        if (agents.length === 1) {
          return json(generateAgentCard(agents[0]))
        }
        // Multiple agents: return listing with card URLs
        return json({
          message: "Multiple A2A agents available. Use /.well-known/agents.json for listing.",
          agents: agents.map((a) => ({
            id: a.id,
            cardUrl: `/.well-known/agents/${a.id}/card.json`,
          })),
        })
      },
    },

    // Message: send to specific agent
    {
      method: "POST",
      path: "/a2a/:agent/message:send",
      auth: protectedA2AAuth,
      handler: async (req, params) => {
        // Validate A2A version
        const versionErr = validateA2AVersion(req)
        if (versionErr) return addA2AVersionHeader(versionErr)

        const agentErr = agentHandler(params)
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
      auth: protectedA2AAuth,
      handler: async (req, params) => {
        // Validate A2A version
        const versionErr = validateA2AVersion(req)
        if (versionErr) return addA2AVersionHeader(versionErr)

        const agentErr = agentHandler(params)
        if (agentErr) return addA2AVersionHeader(agentErr)

        const agentId = params.agent
        const agent = byID.get(agentId)!

        try {
          const body = (await req.json()) as SendMessageRequest

          // Create task (non-blocking)
          const task = await handleSendMessage(agentId, agent, body, false)

          // Return SSE stream
          const encoder = new TextEncoder()
          const stream = new ReadableStream({
            async start(controller) {
              // Send initial task
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(taskResponse(task))}\n\n`))

              // Subscribe to session events to stream updates
              if (task.sessionId) {
                const unsubscribe = Bus.subscribe(SessionStatus.Event.Status, async (event) => {
                  if (event.properties.sessionID !== task.sessionId) return

                  const currentTask = getTask(task.id)
                  if (!currentTask) {
                    unsubscribe()
                    controller.close()
                    return
                  }

                  // Send status update
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(statusUpdate(currentTask))}\n\n`))

                  // If terminal state, send final artifacts and close
                  if (isTerminalState(currentTask.status.state)) {
                    for (const artifact of currentTask.artifacts) {
                      controller.enqueue(
                        encoder.encode(
                          `data: ${JSON.stringify(artifactUpdate(currentTask, artifact, false, true))}\n\n`,
                        ),
                      )
                    }
                    unsubscribe()
                    controller.close()
                  }
                })
              } else {
                // No session, close immediately
                controller.close()
              }
            },
          })

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
      },
    },

    // Tasks: get task by ID for specific agent
    {
      method: "GET",
      path: "/a2a/:agent/tasks/:id",
      auth: protectedA2AAuth,
      handler: async (req, params) => {
        try {
          const agentErr = agentHandler(params)
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
      auth: protectedA2AAuth,
      handler: async (req, params) => {
        try {
          const agentErr = agentHandler(params)
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
      auth: protectedA2AAuth,
      handler: async (req, params) => {
        try {
          const agentErr = agentHandler(params)
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
      },
    },

    // Tasks: subscribe to task events for specific agent
    // Per A2A spec, SubscribeToTask uses GET (not POST)
    {
      method: "GET",
      path: "/a2a/:agent/tasks/:id:subscribe",
      auth: protectedA2AAuth,
      handler: async (req, params) => {
        try {
          const agentErr = agentHandler(params)
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

          // Return SSE stream for this specific task
          const encoder = new TextEncoder()
          const stream = new ReadableStream({
            async start(controller) {
              // Send current task state
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(taskResponse(task))}\n\n`))

              // If already terminal, close immediately
              if (isTerminalState(task.status.state)) {
                controller.close()
                return
              }

              // Subscribe to session events
              if (task.sessionId) {
                const unsubscribe = Bus.subscribe(SessionStatus.Event.Status, async (event) => {
                  if (event.properties.sessionID !== task.sessionId) return

                  const currentTask = getTask(taskId)
                  if (!currentTask) {
                    unsubscribe()
                    controller.close()
                    return
                  }

                  // Send status update
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(statusUpdate(currentTask))}\n\n`))

                  // If terminal state, send final artifacts and close
                  if (isTerminalState(currentTask.status.state)) {
                    for (const artifact of currentTask.artifacts) {
                      controller.enqueue(
                        encoder.encode(
                          `data: ${JSON.stringify(artifactUpdate(currentTask, artifact, false, true))}\n\n`,
                        ),
                      )
                    }
                    unsubscribe()
                    controller.close()
                  }
                })
              } else {
                controller.close()
              }
            },
          })

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
      },
    },
  ]

  const result: Hooks = {
    "http.route": routes,
  }
  return result
}
