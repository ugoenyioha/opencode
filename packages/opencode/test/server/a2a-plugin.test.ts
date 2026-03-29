// Set API key for A2A auth middleware
process.env["OPENCODE_A2A_API_KEY"] = "test-a2a-key"

import { afterAll, describe, expect, spyOn, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { createPublicKey, createSign, generateKeyPairSync } from "crypto"
import { createServer } from "http"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Env } from "../../src/env"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { Config } from "../../src/config/config"
import { Plugin } from "../../src/plugin"
import { Agent } from "../../src/agent/agent"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionStatus } from "../../src/session/status"
import { Bus } from "../../src/bus"

Log.init({ print: false })

const AUTH_HEADER = { "X-A2A-Key": "test-a2a-key" }

function encodeBase64url(input: string | Buffer) {
  const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : input
  return buffer.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")
}

function signRS256(payload: Record<string, unknown>, privateKey: string, kid: string) {
  const header = { alg: "RS256", typ: "JWT", kid }
  const encodedHeader = encodeBase64url(JSON.stringify(header))
  const encodedPayload = encodeBase64url(JSON.stringify(payload))
  const signingInput = `${encodedHeader}.${encodedPayload}`
  const signer = createSign("RSA-SHA256")
  signer.update(signingInput)
  signer.end()
  const signature = signer.sign(privateKey)
  return `${signingInput}.${encodeBase64url(signature)}`
}

// Clean up env var so it doesn't bleed into other test files
afterAll(() => {
  delete process.env["OPENCODE_A2A_API_KEY"]
})

/**
 * Creates a test project with an A2A agent and skill
 */
async function project(enabled: boolean) {
  return tmpdir({
    init: async (dir) => {
      // Create skill with a2a.expose: true
      const skillDir = path.join(dir, ".opencode", "skills", "sidecar-preserve")
      await fs.mkdir(skillDir, { recursive: true })
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: sidecar-preserve
description: Build and preserve the sidecar container image
a2a:
  expose: true
  tags: ["docker", "build"]
  examples: ["Build the sidecar image"]
oasf:
  skills:
    - name: agent_orchestration/task_decomposition
      id: 1001
---
Skill body.
`,
      )

      // Create agent with mode: a2a
      const agentDir = path.join(dir, ".opencode", "agents")
      await fs.mkdir(agentDir, { recursive: true })
      await Bun.write(
        path.join(agentDir, "neo-sidecar.md"),
        `---
name: neo-sidecar
description: AI-powered container build and deployment agent
mode: a2a
skills:
  - sidecar-preserve
a2a:
  baseUrl: https://example.test
  version: "1.0.0"
  auth: ["api-key"]
---
You are a container build agent.
`,
      )

      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          server: {
            a2a: {
              enabled,
              baseUrl: "https://example.test",
              securitySchemes: {
                apiKey: {
                  type: "apiKey",
                  location: "header",
                  name: "X-A2A-Key",
                },
              },
            },
          },
        }),
      )
    },
  })
}

async function projectWithServerA2AAuth(enabled: boolean, auth?: ("api-key" | "jwt" | "spiffe" | "oauth2" | "oidc" | "plugin")[]) {
  return tmpdir({
    init: async (dir) => {
      const skillDir = path.join(dir, ".opencode", "skills", "sidecar-preserve")
      await fs.mkdir(skillDir, { recursive: true })
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: sidecar-preserve
description: Build and preserve the sidecar container image
a2a:
  expose: true
  tags: ["docker", "build"]
---
Skill body.
`,
      )

      const agentDir = path.join(dir, ".opencode", "agents")
      await fs.mkdir(agentDir, { recursive: true })
      await Bun.write(
        path.join(agentDir, "neo-sidecar.md"),
        `---
name: neo-sidecar
description: AI-powered container build and deployment agent
mode: a2a
skills:
  - sidecar-preserve
a2a:
  baseUrl: https://example.test
  version: "1.0.0"
---
You are a container build agent.
`,
      )

      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          server: {
            a2a: {
              enabled,
              baseUrl: "https://example.test",
              ...(auth ? { auth } : {}),
            },
          },
        }),
      )
    },
  })
}

async function projectTwoAgents(enabled: boolean) {
  return tmpdir({
    init: async (dir) => {
      for (const skill of ["sidecar-preserve", "audit-skill"]) {
        const skillDir = path.join(dir, ".opencode", "skills", skill)
        await fs.mkdir(skillDir, { recursive: true })
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: ${skill}
description: Skill ${skill}
a2a:
  expose: true
  tags: ["test"]
---
Skill body.
`,
        )
      }

      const agentDir = path.join(dir, ".opencode", "agents")
      await fs.mkdir(agentDir, { recursive: true })
      for (const [name, skill] of [
        ["neo-sidecar", "sidecar-preserve"],
        ["audit-agent", "audit-skill"],
      ]) {
        await Bun.write(
          path.join(agentDir, `${name}.md`),
          `---
name: ${name}
description: Agent ${name}
mode: a2a
skills:
  - ${skill}
a2a:
  baseUrl: https://example.test
---
Agent body.
`,
        )
      }

      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          server: {
            a2a: {
              enabled,
              baseUrl: "https://example.test",
            },
          },
        }),
      )
    },
  })
}

function ssePayloads(body: string) {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6))
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, any>)
}

describe("a2a internal plugin", () => {
  test("serves agent card at standard path when enabled", async () => {
    await using tmp = await project(true)
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()
        const response = await app.request("/.well-known/agent-card.json", {
          headers: { "x-opencode-directory": tmp.path },
        })
        expect(response.status).toBe(200)
        expect(response.headers.get("content-type")).toContain("application/a2a+json")
        const body = (await response.json()) as any
        expect(body.name).toBe("neo-sidecar")
        expect(body.description).toBe("AI-powered container build and deployment agent")
        expect(body.skills).toHaveLength(1)
        expect(body.skills[0].id).toBe("sidecar-preserve")
        expect(body.skills[0].tags).toContain("docker")
        // Check supportedInterfaces has correct agent URL
        expect(body.supportedInterfaces[0].url).toBe("https://example.test/a2a/neo-sidecar")
        expect(body.supportedInterfaces[0].protocolBinding).toBe("HTTP+JSON")
        // Check securityRequirements (not "security")
        expect(body.securityRequirements).toBeDefined()
      },
    })
  })

  test("serves agent card at client compatibility path", async () => {
    await using tmp = await project(true)
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()
        const response = await app.request("/.well-known/a2a/agent-card", {
          headers: { "x-opencode-directory": tmp.path },
        })
        expect(response.status).toBe(200)
        expect(response.headers.get("content-type")).toContain("application/a2a+json")
        const body = (await response.json()) as any
        expect(body.name).toBe("neo-sidecar")
      },
    })
  })

  test("serves agent listing at /.well-known/agents.json", async () => {
    await using tmp = await project(true)
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()
        const response = await app.request("/.well-known/agents.json", {
          headers: { "x-opencode-directory": tmp.path },
        })
        expect(response.status).toBe(200)
        const body = (await response.json()) as any
        expect(body.agents).toHaveLength(1)
        expect(body.agents[0].id).toBe("neo-sidecar")
        expect(body.agents[0].cardUrl).toBe("/.well-known/agents/neo-sidecar/card.json")
      },
    })
  })

  test("serves per-agent card at /.well-known/agents/:agent/card.json", async () => {
    await using tmp = await project(true)
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()
        const response = await app.request("/.well-known/agents/neo-sidecar/card.json", {
          headers: { "x-opencode-directory": tmp.path },
        })
        expect(response.status).toBe(200)
        const body = (await response.json()) as any
        expect(body.name).toBe("neo-sidecar")
      },
    })
  })

  test("returns 404 for unknown agent card", async () => {
    await using tmp = await project(true)
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()
        const response = await app.request("/.well-known/agents/unknown-agent/card.json", {
          headers: { "x-opencode-directory": tmp.path },
        })
        expect(response.status).toBe(404)
      },
    })
  })

  test("returns 404 when disabled", async () => {
    await using tmp = await project(false)
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        expect((await Config.get()).server?.a2a?.enabled).toBe(false)
        expect(
          (await Plugin.collectRoutes(true)).find((x) => x.path === "/.well-known/agent-card.json"),
        ).toBeUndefined()
      },
    })
  })

  test("returns 404 for unknown agent route", async () => {
    await using tmp = await project(true)
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()
        const response = await app.request("/a2a/unknown-agent/tasks", {
          headers: { "x-opencode-directory": tmp.path, ...AUTH_HEADER },
        })
        expect(response.status).toBe(404)
      },
    })
  })

  test("message endpoint validates request and returns error for invalid request", async () => {
    await using tmp = await project(true)
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()
        // Missing required messageId and role fields
        const response = await app.request("/a2a/neo-sidecar/message:send", {
          method: "POST",
          headers: {
            "x-opencode-directory": tmp.path,
            "content-type": "application/json",
            "A2A-Version": "1.0",
            ...AUTH_HEADER,
          },
          body: JSON.stringify({ message: { parts: [{ text: "hello" }] } }),
        })
        expect(response.status).toBe(400)
        const body = (await response.json()) as any
        expect(body.error).toBeDefined()
      },
    })
  })

  test("agent card has correct A2A spec structure", async () => {
    await using tmp = await project(true)
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()
        const response = await app.request("/.well-known/agent-card.json", {
          headers: { "x-opencode-directory": tmp.path },
        })
        const body = (await response.json()) as any

        // Required top-level fields per A2A spec
        expect(body.name).toBeDefined()
        expect(body.description).toBeDefined()
        expect(body.version).toBeDefined()
        expect(body.supportedInterfaces).toBeArray()
        expect(body.capabilities).toBeDefined()
        expect(body.defaultInputModes).toBeArray()
        expect(body.defaultOutputModes).toBeArray()
        expect(body.skills).toBeArray()

        // Capabilities structure
        expect(body.capabilities.streaming).toBe(true)
        expect(body.capabilities.pushNotifications).toBe(false)
        expect(body.capabilities.extendedAgentCard).toBe(false)

        // securityRequirements (not "security") per A2A spec
        expect(body.securityRequirements).toBeDefined()
        expect(body.security).toBeUndefined() // Should NOT have old field name

        // supportedInterfaces structure
        const iface = body.supportedInterfaces[0]
        expect(iface.url).toBeDefined()
        expect(iface.protocolBinding).toBe("HTTP+JSON")
        expect(iface.protocolVersion).toBe("1.0")

        // Skills have required fields
        const skill = body.skills[0]
        expect(skill.id).toBeDefined()
        expect(skill.name).toBeDefined()
        expect(skill.description).toBeDefined()
        expect(skill.tags).toBeArray()
        expect(skill.tags.length).toBeGreaterThan(0)
      },
    })
  })

  test("OASF extensions are included when present", async () => {
    await using tmp = await project(true)
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()
        const response = await app.request("/.well-known/agent-card.json", {
          headers: { "x-opencode-directory": tmp.path },
        })
        const body = (await response.json()) as any
        const skill = body.skills[0]

        // Skill should have OASF extension from frontmatter
        expect(skill.extensions).toBeDefined()
        expect(skill.extensions.oasf).toBeDefined()
        expect(skill.extensions.oasf.skills).toBeArray()
        expect(skill.extensions.oasf.skills[0].name).toBe("agent_orchestration/task_decomposition")
        expect(skill.extensions.oasf.skills[0].id).toBe(1001)
      },
    })
  })

  test("agents without mode: a2a are not exposed", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        // Create skill with a2a.expose
        const skillDir = path.join(dir, ".opencode", "skills", "my-skill")
        await fs.mkdir(skillDir, { recursive: true })
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: my-skill
description: A skill
a2a:
  expose: true
  tags: ["test"]
---
Skill body.
`,
        )

        // Create agent WITHOUT mode: a2a (regular agent)
        const agentDir = path.join(dir, ".opencode", "agents")
        await fs.mkdir(agentDir, { recursive: true })
        await Bun.write(
          path.join(agentDir, "regular-agent.md"),
          `---
name: regular-agent
description: Regular agent (not A2A)
skills:
  - my-skill
---
Regular agent prompt.
`,
        )

        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            server: {
              a2a: {
                enabled: true,
                baseUrl: "https://example.test",
              },
            },
          }),
        )
      },
    })

    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()
        const response = await app.request("/.well-known/agent-card.json", {
          headers: { "x-opencode-directory": tmp.path },
        })
        // No A2A agents, should return 404
        expect(response.status).toBe(404)
      },
    })
  })

  test("multiple agents returns listing at standard path", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        // Create two skills
        for (const name of ["skill-a", "skill-b"]) {
          const skillDir = path.join(dir, ".opencode", "skills", name)
          await fs.mkdir(skillDir, { recursive: true })
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---
name: ${name}
description: Skill ${name}
a2a:
  expose: true
  tags: ["test"]
---
Skill body.
`,
          )
        }

        // Create two A2A agents
        const agentDir = path.join(dir, ".opencode", "agents")
        await fs.mkdir(agentDir, { recursive: true })
        for (const [name, skill] of [
          ["agent-one", "skill-a"],
          ["agent-two", "skill-b"],
        ]) {
          await Bun.write(
            path.join(agentDir, `${name}.md`),
            `---
name: ${name}
description: Agent ${name}
mode: a2a
skills:
  - ${skill}
---
Agent prompt.
`,
          )
        }

        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            server: {
              a2a: {
                enabled: true,
                baseUrl: "https://example.test",
              },
            },
          }),
        )
      },
    })

    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()

        // Standard path with multiple agents returns first agent's card (A2A spec §8.1)
        const response = await app.request("/.well-known/agent-card.json", {
          headers: { "x-opencode-directory": tmp.path },
        })
        expect(response.status).toBe(200)
        const body = (await response.json()) as any
        // Must be a valid AgentCard (not a listing), per A2A spec §8.1
        expect(body.name).toBeDefined()
        expect(body.supportedInterfaces).toBeDefined()
        expect(body.capabilities).toBeDefined()
        expect(body.skills).toBeDefined()

        // Agents listing should work
        const listResponse = await app.request("/.well-known/agents.json", {
          headers: { "x-opencode-directory": tmp.path },
        })
        expect(listResponse.status).toBe(200)
        const listBody = (await listResponse.json()) as any
        expect(listBody.agents).toHaveLength(2)

        // Each agent should have its own card
        for (const agent of listBody.agents) {
          const cardResponse = await app.request(agent.cardUrl, {
            headers: { "x-opencode-directory": tmp.path },
          })
          expect(cardResponse.status).toBe(200)
        }
      },
    })
  })

  test("skills without a2a.expose are not included in agent card", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        // Create skill WITHOUT a2a.expose
        const skillDir = path.join(dir, ".opencode", "skills", "internal-skill")
        await fs.mkdir(skillDir, { recursive: true })
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: internal-skill
description: Internal helper skill
---
Internal skill body.
`,
        )

        // Create skill WITH a2a.expose
        const exposedSkillDir = path.join(dir, ".opencode", "skills", "exposed-skill")
        await fs.mkdir(exposedSkillDir, { recursive: true })
        await Bun.write(
          path.join(exposedSkillDir, "SKILL.md"),
          `---
name: exposed-skill
description: Exposed skill
a2a:
  expose: true
  tags: ["test"]
---
Exposed skill body.
`,
        )

        // Create agent referencing both skills
        const agentDir = path.join(dir, ".opencode", "agents")
        await fs.mkdir(agentDir, { recursive: true })
        await Bun.write(
          path.join(agentDir, "test-agent.md"),
          `---
name: test-agent
description: Test agent
mode: a2a
skills:
  - internal-skill
  - exposed-skill
---
Test agent prompt.
`,
        )

        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            server: {
              a2a: {
                enabled: true,
                baseUrl: "https://example.test",
              },
            },
          }),
        )
      },
    })

    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()
        const response = await app.request("/.well-known/agent-card.json", {
          headers: { "x-opencode-directory": tmp.path },
        })
        expect(response.status).toBe(200)
        const body = (await response.json()) as any
        // Only exposed-skill should be in the card
        expect(body.skills).toHaveLength(1)
        expect(body.skills[0].id).toBe("exposed-skill")
      },
    })
  })

  // ============================================================================
  // Part 2 Tests: Task Lifecycle & Messaging
  // ============================================================================

  test("message:send rejects unsupported A2A version", async () => {
    await using tmp = await project(true)
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()
        const response = await app.request("/a2a/neo-sidecar/message:send", {
          method: "POST",
          headers: {
            "x-opencode-directory": tmp.path,
            "content-type": "application/json",
            "A2A-Version": "2.0", // Unsupported version
            ...AUTH_HEADER,
          },
          body: JSON.stringify({
            message: {
              messageId: "test-1",
              role: "ROLE_USER",
              parts: [{ text: "hello" }],
            },
          }),
        })
        expect(response.status).toBe(400)
        expect(response.headers.get("A2A-Version")).toBe("1.0")
        const body = (await response.json()) as any
        expect(body.error.code).toBe(-32009) // VersionNotSupportedError
        expect(body.error.data.supportedVersions).toContain("1.0")
      },
    })
  })

  test("message:send validates required message fields", async () => {
    await using tmp = await project(true)
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()

        // Missing messageId
        const response1 = await app.request("/a2a/neo-sidecar/message:send", {
          method: "POST",
          headers: {
            "x-opencode-directory": tmp.path,
            "content-type": "application/json",
            "A2A-Version": "1.0",
            ...AUTH_HEADER,
          },
          body: JSON.stringify({
            message: {
              role: "ROLE_USER",
              parts: [{ text: "hello" }],
            },
          }),
        })
        expect(response1.status).toBe(400)

        // Missing parts
        const response2 = await app.request("/a2a/neo-sidecar/message:send", {
          method: "POST",
          headers: {
            "x-opencode-directory": tmp.path,
            "content-type": "application/json",
            "A2A-Version": "1.0",
            ...AUTH_HEADER,
          },
          body: JSON.stringify({
            message: {
              messageId: "test-1",
              role: "ROLE_USER",
              parts: [],
            },
          }),
        })
        expect(response2.status).toBe(400)

        // Wrong role
        const response3 = await app.request("/a2a/neo-sidecar/message:send", {
          method: "POST",
          headers: {
            "x-opencode-directory": tmp.path,
            "content-type": "application/json",
            "A2A-Version": "1.0",
            ...AUTH_HEADER,
          },
          body: JSON.stringify({
            message: {
              messageId: "test-1",
              role: "ROLE_AGENT", // Should be ROLE_USER
              parts: [{ text: "hello" }],
            },
          }),
        })
        expect(response3.status).toBe(400)
      },
    })
  })

  test("message:send forwards configuration.model to SessionPrompt", async () => {
    await using tmp = await project(true)
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const promptSpy = spyOn(SessionPrompt, "prompt").mockResolvedValue(undefined as any)
        try {
          const app = Server.App()
          const response = await app.request("/a2a/neo-sidecar/message:send", {
            method: "POST",
            headers: {
              "x-opencode-directory": tmp.path,
              "content-type": "application/json",
              "A2A-Version": "1.0",
              ...AUTH_HEADER,
            },
            body: JSON.stringify({
              message: {
                messageId: "test-model-forward",
                role: "ROLE_USER",
                parts: [{ text: "hello" }],
              },
              configuration: {
                model: "openai/gpt-5.3-codex",
              },
            }),
          })
          expect(response.status).toBe(200)
          expect(promptSpy).toHaveBeenCalled()
          expect(promptSpy.mock.calls[0]?.[0]).toMatchObject({
            model: {
              providerID: "openai",
              modelID: "gpt-5.3-codex",
            },
          })
        } finally {
          promptSpy.mockRestore()
        }
      },
    })
  })

  test("message:send rejects invalid configuration.model format", async () => {
    await using tmp = await project(true)
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()
        const response = await app.request("/a2a/neo-sidecar/message:send", {
          method: "POST",
          headers: {
            "x-opencode-directory": tmp.path,
            "content-type": "application/json",
            "A2A-Version": "1.0",
            ...AUTH_HEADER,
          },
          body: JSON.stringify({
            message: {
              messageId: "test-model-invalid",
              role: "ROLE_USER",
              parts: [{ text: "hello" }],
            },
            configuration: {
              model: "gpt-5.3-codex",
            },
          }),
        })
        expect(response.status).toBe(400)
        const body = (await response.json()) as any
        expect(body.error.message).toContain("configuration.model")
      },
    })
  })

  test("tasks endpoint returns empty list initially", async () => {
    await using tmp = await project(true)
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()
        const response = await app.request("/a2a/neo-sidecar/tasks", {
          method: "GET",
          headers: {
            "x-opencode-directory": tmp.path,
            ...AUTH_HEADER,
          },
        })
        expect(response.status).toBe(200)
        const body = (await response.json()) as any
        expect(body.tasks).toBeArray()
      },
    })
  })

  test("tasks/:id returns 404 for unknown task", async () => {
    await using tmp = await project(true)
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()
        const response = await app.request("/a2a/neo-sidecar/tasks/unknown-task-id", {
          method: "GET",
          headers: {
            "x-opencode-directory": tmp.path,
            ...AUTH_HEADER,
          },
        })
        expect(response.status).toBe(404)
      },
    })
  })

  test("tasks/:id:cancel returns 404 for unknown task", async () => {
    await using tmp = await project(true)
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()
        const response = await app.request("/a2a/neo-sidecar/tasks/unknown-task-id:cancel", {
          method: "POST",
          headers: {
            "x-opencode-directory": tmp.path,
            ...AUTH_HEADER,
          },
        })
        expect(response.status).toBe(404)
      },
    })
  })

  test("tasks/:id:subscribe returns 404 for unknown task", async () => {
    await using tmp = await project(true)
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()
        const response = await app.request("/a2a/neo-sidecar/tasks/unknown-task-id:subscribe", {
          method: "GET", // Per A2A spec, subscribe uses GET
          headers: {
            "x-opencode-directory": tmp.path,
            ...AUTH_HEADER,
          },
        })
        expect(response.status).toBe(404)
      },
    })
  })

  test("message:send returns A2A-Version header", async () => {
    await using tmp = await project(true)
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()
        const response = await app.request("/a2a/neo-sidecar/message:send", {
          method: "POST",
          headers: {
            "x-opencode-directory": tmp.path,
            "content-type": "application/json",
            "A2A-Version": "1.0",
            ...AUTH_HEADER,
          },
          body: JSON.stringify({
            message: {
              messageId: "test-1",
              role: "ROLE_USER",
              parts: [{ text: "hello" }],
            },
          }),
        })
        // Even if the request fails for other reasons, we should get the version header
        expect(response.headers.get("A2A-Version")).toBe("1.0")
      },
    })
  })

  test("message:send accepts missing A2A-Version header", async () => {
    await using tmp = await project(true)
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()
        const response = await app.request("/a2a/neo-sidecar/message:send", {
          method: "POST",
          headers: {
            "x-opencode-directory": tmp.path,
            "content-type": "application/json",
            ...AUTH_HEADER,
          },
          body: JSON.stringify({
            message: {
              messageId: "missing-version-ok",
              role: "ROLE_USER",
              parts: [{ text: "hello" }],
            },
          }),
        })
        expect(response.status).toBe(200)
        expect(response.headers.get("A2A-Version")).toBe("1.0")
        const body = (await response.json()) as any
        expect(body.task).toBeDefined()
      },
    })
  })

  test("agent/task isolation: task endpoints return 404 for another agent task", async () => {
    await using tmp = await projectTwoAgents(true)
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()
        const created = await app.request("/a2a/neo-sidecar/message:send", {
          method: "POST",
          headers: {
            "x-opencode-directory": tmp.path,
            "content-type": "application/json",
            ...AUTH_HEADER,
          },
          body: JSON.stringify({
            message: {
              messageId: "cross-agent",
              role: "ROLE_USER",
              parts: [{ text: "hello" }],
            },
          }),
        })
        expect(created.status).toBe(200)
        const createdBody = (await created.json()) as any
        const taskId = createdBody.task.id as string

        const getOther = await app.request(`/a2a/audit-agent/tasks/${taskId}`, {
          method: "GET",
          headers: { "x-opencode-directory": tmp.path, ...AUTH_HEADER },
        })
        expect(getOther.status).toBe(404)

        const cancelOther = await app.request(`/a2a/audit-agent/tasks/${taskId}/cancel`, {
          method: "POST",
          headers: { "x-opencode-directory": tmp.path, ...AUTH_HEADER },
        })
        expect(cancelOther.status).toBe(404)

        const subscribeOther = await app.request(`/a2a/audit-agent/tasks/${taskId}/subscribe`, {
          method: "GET",
          headers: { "x-opencode-directory": tmp.path, ...AUTH_HEADER },
        })
        expect(subscribeOther.status).toBe(404)
      },
    })
  })

  test("message:stream emits task envelope first, then terminal status, then artifact", async () => {
    await using tmp = await project(true)
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const createSpy = spyOn(Session, "create").mockResolvedValue({ id: "ses-stream-1" } as any)
        const messagesSpy = spyOn(Session, "messages").mockResolvedValue([
          {
            info: { role: "assistant", id: "assistant-1" },
            parts: [{ type: "text", text: "stream output", synthetic: false }],
          },
        ] as any)
        const promptSpy = spyOn(SessionPrompt, "prompt").mockResolvedValue(undefined as any)

        try {
          const app = Server.App()
          const response = await app.request("/a2a/neo-sidecar/message/stream", {
            method: "POST",
            headers: {
              "x-opencode-directory": tmp.path,
              "content-type": "application/json",
              ...AUTH_HEADER,
            },
            body: JSON.stringify({
              message: {
                messageId: "stream-order",
                role: "ROLE_USER",
                parts: [{ text: "hello" }],
              },
            }),
          })

          expect(response.status).toBe(200)
          expect(response.headers.get("content-type")).toContain("text/event-stream")

          setTimeout(() => {
            SessionStatus.set("ses-stream-1", { type: "idle" })
          }, 20)

          const decoder = new TextDecoder()
          const reader = response.body?.getReader()
          let body = ""

          if (!reader) throw new Error("Missing stream body")

          const start = Date.now()
          while (Date.now() - start < 4000) {
            const readResult = await Promise.race([
              reader.read().then((result) => ({ ...result, timeout: false })),
              new Promise<{ done: false; value?: undefined; timeout: true }>((resolve) =>
                setTimeout(() => resolve({ done: false, timeout: true }), 200),
              ),
            ])

            if (readResult.timeout) continue

            if (readResult.value) {
              body += decoder.decode(readResult.value)
            }

            if (body.includes("artifactUpdate") || readResult.done) {
              break
            }
          }

          await reader.cancel()
          const payloads = ssePayloads(body)
          expect(payloads[0]?.task).toBeDefined()

          const terminalStatusIndex = payloads.findIndex(
            (payload) => payload.statusUpdate?.status?.state === "TASK_STATE_COMPLETED",
          )
          const artifactIndex = payloads.findIndex((payload) => payload.artifactUpdate)

          expect(terminalStatusIndex).toBeGreaterThan(0)
          expect(artifactIndex).toBeGreaterThan(terminalStatusIndex)
          expect(payloads[artifactIndex]?.artifactUpdate?.append).toBe(false)
          expect(payloads[artifactIndex]?.artifactUpdate?.lastChunk).toBe(true)
        } finally {
          createSpy.mockRestore()
          messagesSpy.mockRestore()
          promptSpy.mockRestore()
        }
      },
    })
  })

  test("failed task response message is sanitized and does not leak sessionId", async () => {
    await using tmp = await project(true)
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const promptSpy = spyOn(SessionPrompt, "prompt").mockImplementation((async () => {
          throw new Error("Session prompt failed\n    at SecretStack (/internal/stack) sessionId=ses-999 token=abc123")
        }) as any)

        try {
          const app = Server.App()
          const send = await app.request("/a2a/neo-sidecar/message:send", {
            method: "POST",
            headers: {
              "x-opencode-directory": tmp.path,
              "content-type": "application/json",
              ...AUTH_HEADER,
            },
            body: JSON.stringify({
              message: {
                messageId: "sanitized-fail",
                role: "ROLE_USER",
                parts: [{ text: "hello" }],
              },
            }),
          })
          expect(send.status).toBe(200)
          const sendBody = (await send.json()) as any
          const taskId = sendBody.task.id as string

          let failedBody: any = undefined
          for (let i = 0; i < 40; i++) {
            await new Promise((resolve) => setTimeout(resolve, 25))
            const taskResponse = await app.request(`/a2a/neo-sidecar/tasks/${taskId}`, {
              method: "GET",
              headers: {
                "x-opencode-directory": tmp.path,
                ...AUTH_HEADER,
              },
            })
            failedBody = await taskResponse.json()
            if (failedBody.task?.status?.state === "TASK_STATE_FAILED") break
          }

          expect(failedBody.task.status.state).toBe("TASK_STATE_FAILED")
          expect(failedBody.task.status.message).toBe("Session prompt failed")
          expect(failedBody.task.status.message).not.toContain("\n")
          expect(failedBody.task.status.message).not.toContain("at ")
          expect(failedBody.task.status.message).not.toContain("sessionId")
          expect(JSON.stringify(failedBody)).not.toContain("sessionId")
        } finally {
          promptSpy.mockRestore()
        }
      },
    })
  })

  test("subscribe returns task envelope and closes immediately for terminal tasks", async () => {
    await using tmp = await project(true)
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const promptSpy = spyOn(SessionPrompt, "prompt").mockImplementation((async () => {
          throw new Error("forced fail")
        }) as any)

        try {
          const app = Server.App()
          const send = await app.request("/a2a/neo-sidecar/message:send", {
            method: "POST",
            headers: {
              "x-opencode-directory": tmp.path,
              "content-type": "application/json",
              ...AUTH_HEADER,
            },
            body: JSON.stringify({
              message: {
                messageId: "subscribe-terminal",
                role: "ROLE_USER",
                parts: [{ text: "hello" }],
              },
            }),
          })
          const sendBody = (await send.json()) as any
          const taskId = sendBody.task.id as string

          for (let i = 0; i < 40; i++) {
            await new Promise((resolve) => setTimeout(resolve, 25))
            const taskResponse = await app.request(`/a2a/neo-sidecar/tasks/${taskId}`, {
              method: "GET",
              headers: {
                "x-opencode-directory": tmp.path,
                ...AUTH_HEADER,
              },
            })
            const body = (await taskResponse.json()) as any
            if (body.task?.status?.state === "TASK_STATE_FAILED") break
          }

          const response = await app.request(`/a2a/neo-sidecar/tasks/${taskId}/subscribe`, {
            method: "GET",
            headers: {
              "x-opencode-directory": tmp.path,
              ...AUTH_HEADER,
            },
          })
          expect(response.status).toBe(200)
          const body = await response.text()
          const payloads = ssePayloads(body)
          expect(payloads).toHaveLength(1)
          expect(payloads[0]?.task?.id).toBe(taskId)
          expect(payloads[0]?.task?.status?.state).toBe("TASK_STATE_FAILED")
        } finally {
          promptSpy.mockRestore()
        }
      },
    })
  })

  test("cancel is idempotent for existing tasks", async () => {
    await using tmp = await project(true)
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const promptSpy = spyOn(SessionPrompt, "prompt").mockImplementation((async () => {
          await new Promise(() => {})
        }) as any)
        const busSpy = spyOn(Bus, "subscribe").mockImplementation(() => {
          return () => {}
        })

        try {
          const app = Server.App()
          const send = await app.request("/a2a/neo-sidecar/message:send", {
            method: "POST",
            headers: {
              "x-opencode-directory": tmp.path,
              "content-type": "application/json",
              ...AUTH_HEADER,
            },
            body: JSON.stringify({
              message: {
                messageId: "cancel-idempotent",
                role: "ROLE_USER",
                parts: [{ text: "hello" }],
              },
            }),
          })
          expect(send.status).toBe(200)
          const sendBody = (await send.json()) as any
          const taskId = sendBody.task.id as string

          const cancel1 = await app.request(`/a2a/neo-sidecar/tasks/${taskId}/cancel`, {
            method: "POST",
            headers: {
              "x-opencode-directory": tmp.path,
              ...AUTH_HEADER,
            },
          })
          expect(cancel1.status).toBe(200)
          const body1 = (await cancel1.json()) as any
          expect(body1.task.status.state).toBe("TASK_STATE_CANCELED")

          const cancel2 = await app.request(`/a2a/neo-sidecar/tasks/${taskId}/cancel`, {
            method: "POST",
            headers: {
              "x-opencode-directory": tmp.path,
              ...AUTH_HEADER,
            },
          })
          expect(cancel2.status).toBe(200)
          const body2 = (await cancel2.json()) as any
          expect(body2.task.status.state).toBe("TASK_STATE_CANCELED")
        } finally {
          busSpy.mockRestore()
          promptSpy.mockRestore()
        }
      },
    })
  })

  // ============================================================================
  // Part 3 Tests: Authentication
  // ============================================================================

  test("auth: request without API key returns 401", async () => {
    await using tmp = await project(true)
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()
        // No X-A2A-Key header — per-agent auth rejects
        const response = await app.request("/a2a/neo-sidecar/tasks", {
          method: "GET",
          headers: {
            "x-opencode-directory": tmp.path,
          },
        })
        expect(response.status).toBe(401)
        const body = (await response.json()) as any
        expect(body.error.code).toBe("Unauthorized")
      },
    })
  })

  test("auth: request with wrong API key returns 401", async () => {
    await using tmp = await project(true)
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()
        const response = await app.request("/a2a/neo-sidecar/tasks", {
          method: "GET",
          headers: {
            "x-opencode-directory": tmp.path,
            "X-A2A-Key": "wrong-key",
          },
        })
        expect(response.status).toBe(401)
        const body = (await response.json()) as any
        expect(body.error.code).toBe("Unauthorized")
      },
    })
  })

  test("auth: request with correct API key returns 200", async () => {
    await using tmp = await project(true)
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()
        const response = await app.request("/a2a/neo-sidecar/tasks", {
          method: "GET",
          headers: {
            "x-opencode-directory": tmp.path,
            ...AUTH_HEADER,
          },
        })
        expect(response.status).toBe(200)
        const body = (await response.json()) as any
        expect(body.tasks).toBeArray()
      },
    })
  })

  test("auth: discovery routes do not require API key", async () => {
    await using tmp = await project(true)
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()

        // All discovery routes should work without auth
        const cardResponse = await app.request("/.well-known/agent-card.json", {
          headers: { "x-opencode-directory": tmp.path },
        })
        expect(cardResponse.status).toBe(200)

        const compatResponse = await app.request("/.well-known/a2a/agent-card", {
          headers: { "x-opencode-directory": tmp.path },
        })
        expect(compatResponse.status).toBe(200)

        const agentsResponse = await app.request("/.well-known/agents.json", {
          headers: { "x-opencode-directory": tmp.path },
        })
        expect(agentsResponse.status).toBe(200)

        const perAgentResponse = await app.request("/.well-known/agents/neo-sidecar/card.json", {
          headers: { "x-opencode-directory": tmp.path },
        })
        expect(perAgentResponse.status).toBe(200)
      },
    })
  })

  test("auth: agent inherits server-level auth when no per-agent config", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        // Create skill with a2a.expose
        const skillDir = path.join(dir, ".opencode", "skills", "open-skill")
        await fs.mkdir(skillDir, { recursive: true })
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: open-skill
description: Publicly accessible skill
a2a:
  expose: true
  tags: ["public"]
---
Open skill body.
`,
        )

        // Create agent with mode: a2a but NO agent-level auth strategies
        const agentDir = path.join(dir, ".opencode", "agents")
        await fs.mkdir(agentDir, { recursive: true })
        await Bun.write(
          path.join(agentDir, "inherit-agent.md"),
          `---
name: inherit-agent
description: Agent that inherits server auth
mode: a2a
skills:
  - open-skill
a2a:
  baseUrl: https://example.test
  version: "1.0.0"
---
Agent without per-agent auth config.
`,
        )

        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            server: {
              a2a: {
                enabled: true,
                baseUrl: "https://example.test",
                auth: ["api-key"],
              },
            },
          }),
        )
      },
    })

    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()

        // Without API key — per-agent auth inherits server auth and rejects
        const noKeyResponse = await app.request("/a2a/inherit-agent/tasks", {
          method: "GET",
          headers: {
            "x-opencode-directory": tmp.path,
          },
        })
        expect(noKeyResponse.status).toBe(401)

        // With API key — per-agent auth passes (inherited from server)
        const withKeyResponse = await app.request("/a2a/inherit-agent/tasks", {
          method: "GET",
          headers: {
            "x-opencode-directory": tmp.path,
            ...AUTH_HEADER,
          },
        })
        expect(withKeyResponse.status).toBe(200)
        const body = (await withKeyResponse.json()) as any
        expect(body.tasks).toBeArray()
      },
    })
  })

  test("auth: server.a2a jwt enforces strict bearer semantics over x-api-key", async () => {
    await using tmp = await projectWithServerA2AAuth(true, ["jwt"])
    await Instance.disposeAll()
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { format: "pem", type: "spki" },
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
    })
    const kid = "a2a-jwt-kid"
    const jwk = createPublicKey(publicKey).export({ format: "jwk" }) as Record<string, unknown>
    const jwks = createServer((req, res) => {
      if (req.url !== "/.well-known/jwks.json") {
        res.statusCode = 404
        res.end()
        return
      }
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ keys: [{ ...jwk, use: "sig", alg: "RS256", kid }] }))
    })
    await new Promise<void>((resolve) => jwks.listen(0, "127.0.0.1", () => resolve()))
    try {
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          Env.set("ANTHROPIC_API_KEY", "test-key")
        },
        fn: async () => {
          const previousJwks = process.env.OPENCODE_USER_JWT_JWKS_URL
          const previousIssuer = process.env.OPENCODE_USER_JWT_ISSUER
          const previousAudience = process.env.OPENCODE_USER_JWT_AUDIENCE
          try {
            const address = jwks.address()
            if (!address || typeof address === "string") throw new Error("failed to start jwks server")
            const jwksUrl = `http://127.0.0.1:${address.port}/.well-known/jwks.json`
            Env.set("OPENCODE_USER_JWT_JWKS_URL", jwksUrl)
            Env.set("OPENCODE_USER_JWT_ISSUER", "a2a-issuer")
            Env.set("OPENCODE_USER_JWT_AUDIENCE", "a2a-audience")

            const app = Server.App()
            const goodToken = signRS256(
              { exp: Math.floor(Date.now() / 1000) + 120, iss: "a2a-issuer", aud: "a2a-audience", sub: "jwt-user-1" },
              privateKey,
              kid,
            )
            const noSubToken = signRS256(
              { exp: Math.floor(Date.now() / 1000) + 120, iss: "a2a-issuer", aud: "a2a-audience" },
              privateKey,
              kid,
            )

            const allowed = await app.request("/a2a/neo-sidecar/tasks", {
              method: "GET",
              headers: {
                "x-opencode-directory": tmp.path,
                authorization: `Bearer ${goodToken}`,
              },
            })
            expect(allowed.status).toBe(200)

            const denied = await app.request("/a2a/neo-sidecar/tasks", {
              method: "GET",
              headers: {
                "x-opencode-directory": tmp.path,
                authorization: "Bearer not-a-jwt",
                ...AUTH_HEADER,
              },
            })
            expect(denied.status).toBe(401)

            const noSubDenied = await app.request("/a2a/neo-sidecar/tasks", {
              method: "GET",
              headers: {
                "x-opencode-directory": tmp.path,
                authorization: `Bearer ${noSubToken}`,
              },
            })
            expect(noSubDenied.status).toBe(401)
          } finally {
            if (previousJwks === undefined) delete process.env.OPENCODE_USER_JWT_JWKS_URL
            else process.env.OPENCODE_USER_JWT_JWKS_URL = previousJwks
            if (previousIssuer === undefined) delete process.env.OPENCODE_USER_JWT_ISSUER
            else process.env.OPENCODE_USER_JWT_ISSUER = previousIssuer
            if (previousAudience === undefined) delete process.env.OPENCODE_USER_JWT_AUDIENCE
            else process.env.OPENCODE_USER_JWT_AUDIENCE = previousAudience
          }
        },
      })
    } finally {
      await new Promise<void>((resolve, reject) => jwks.close((error) => (error ? reject(error) : resolve())))
    }
  })

  test("auth: server.a2a plugin strategy is fail-closed on protected routes", async () => {
    await using tmp = await projectWithServerA2AAuth(true, ["plugin"])
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()
        const response = await app.request("/a2a/neo-sidecar/tasks", {
          method: "GET",
          headers: {
            "x-opencode-directory": tmp.path,
            ...AUTH_HEADER,
          },
        })
        expect(response.status).toBe(401)
        const body = (await response.json()) as any
        expect(body.error.code).toBe("Unauthorized")
      },
    })
  })

  test("auth: empty server.a2a.auth makes agents public (inherited)", async () => {
    await using tmp = await projectWithServerA2AAuth(true, [])
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()

        // Agent inherits server auth: [] (empty array = public)
        const noAuth = await app.request("/a2a/neo-sidecar/tasks", {
          method: "GET",
          headers: { "x-opencode-directory": tmp.path },
        })
        expect(noAuth.status).toBe(200)

        // With API key still works (no auth required)
        const withApiKey = await app.request("/a2a/neo-sidecar/tasks", {
          method: "GET",
          headers: {
            "x-opencode-directory": tmp.path,
            ...AUTH_HEADER,
          },
        })
        expect(withApiKey.status).toBe(200)
      },
    })
  })

  test("auth: discovery routes remain public when server.a2a.auth requires jwt", async () => {
    await using tmp = await projectWithServerA2AAuth(true, ["jwt"])
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()

        const cardResponse = await app.request("/.well-known/agent-card.json", {
          headers: { "x-opencode-directory": tmp.path },
        })
        expect(cardResponse.status).toBe(200)

        const compatResponse = await app.request("/.well-known/a2a/agent-card", {
          headers: { "x-opencode-directory": tmp.path },
        })
        expect(compatResponse.status).toBe(200)

        const agentsResponse = await app.request("/.well-known/agents.json", {
          headers: { "x-opencode-directory": tmp.path },
        })
        expect(agentsResponse.status).toBe(200)

        const perAgentResponse = await app.request("/.well-known/agents/neo-sidecar/card.json", {
          headers: { "x-opencode-directory": tmp.path },
        })
        expect(perAgentResponse.status).toBe(200)
      },
    })
  })

  test("auth: per-agent auth config replaces server-level auth", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        // Create skill
        const skillDir = path.join(dir, ".opencode", "skills", "test-skill")
        await fs.mkdir(skillDir, { recursive: true })
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: test-skill
description: Test skill
a2a:
  expose: true
  tags: ["test"]
---
Skill body.
`,
        )

        // Agent A: requires api-key explicitly
        const agentDir = path.join(dir, ".opencode", "agents")
        await fs.mkdir(agentDir, { recursive: true })
        await Bun.write(
          path.join(agentDir, "auth-agent.md"),
          `---
name: auth-agent
description: Agent requiring API key
mode: a2a
skills:
  - test-skill
a2a:
  baseUrl: https://example.test
  auth: ["api-key"]
---
Agent with auth.
`,
        )

        // Agent B: public (no auth)
        await Bun.write(
          path.join(agentDir, "public-agent.md"),
          `---
name: public-agent
description: Public agent
mode: a2a
skills:
  - test-skill
a2a:
  baseUrl: https://example.test
  auth: []
---
Public agent.
`,
        )

        // Server config: no server-level auth
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            server: {
              a2a: {
                enabled: true,
                baseUrl: "https://example.test",
              },
            },
          }),
        )
      },
    })

    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()

        // auth-agent: requires API key (per-agent auth)
        const authAgentNoKey = await app.request("/a2a/auth-agent/tasks", {
          method: "GET",
          headers: { "x-opencode-directory": tmp.path },
        })
        expect(authAgentNoKey.status).toBe(401)

        const authAgentWithKey = await app.request("/a2a/auth-agent/tasks", {
          method: "GET",
          headers: {
            "x-opencode-directory": tmp.path,
            ...AUTH_HEADER,
          },
        })
        expect(authAgentWithKey.status).toBe(200)

        // public-agent: no auth required (auth: [])
        const publicAgentNoKey = await app.request("/a2a/public-agent/tasks", {
          method: "GET",
          headers: { "x-opencode-directory": tmp.path },
        })
        expect(publicAgentNoKey.status).toBe(200)
      },
    })
  })

  test("auth: per-agent auth empty array overrides server-level auth", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const skillDir = path.join(dir, ".opencode", "skills", "test-skill")
        await fs.mkdir(skillDir, { recursive: true })
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: test-skill
description: Test skill
a2a:
  expose: true
  tags: ["test"]
---
Skill body.
`,
        )

        const agentDir = path.join(dir, ".opencode", "agents")
        await fs.mkdir(agentDir, { recursive: true })
        await Bun.write(
          path.join(agentDir, "public-agent.md"),
          `---
name: public-agent
description: Public override agent
mode: a2a
skills:
  - test-skill
a2a:
  baseUrl: https://example.test
  auth: []
---
Public override.
`,
        )

        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            server: {
              a2a: {
                enabled: true,
                baseUrl: "https://example.test",
                auth: ["api-key"],
              },
            },
          }),
        )
      },
    })

    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()

        const noAuth = await app.request("/a2a/public-agent/tasks", {
          method: "GET",
          headers: { "x-opencode-directory": tmp.path },
        })
        expect(noAuth.status).toBe(200)
      },
    })
  })

  describe("SPIFFE JWT-SVID authentication", () => {
    test("agent card maps SPIFFE auth to JWT-SVID bearer scheme only", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const skillDir = path.join(dir, ".opencode", "skills", "test-skill")
          await fs.mkdir(skillDir, { recursive: true })
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---
name: test-skill
description: Test skill
a2a:
  expose: true
  tags: ["test"]
---
Test skill.
`,
          )

          const agentDir = path.join(dir, ".opencode", "agents")
          await fs.mkdir(agentDir, { recursive: true })
          await Bun.write(
            path.join(agentDir, "spiffe-agent.md"),
            `---
name: spiffe-agent
description: SPIFFE-protected agent
mode: a2a
skills:
  - test-skill
a2a:
  baseUrl: https://example.test
  auth: ["spiffe"]
---
SPIFFE agent.
`,
          )

          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              server: {
                a2a: {
                  enabled: true,
                  baseUrl: "https://example.test",
                  securitySchemes: {
                    jwtBearer: {
                      type: "http",
                      scheme: "Bearer",
                      bearerFormat: "JWT",
                    },
                    spiffeBearer: {
                      type: "http",
                      scheme: "Bearer",
                      bearerFormat: "JWT-SVID",
                    },
                  },
                },
              },
            }),
          )
        },
      })

      await Instance.disposeAll()
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          Env.set("ANTHROPIC_API_KEY", "test-key")
        },
        fn: async () => {
          const app = Server.App()
          const response = await app.request("/.well-known/agents/spiffe-agent/card.json", {
            headers: { "x-opencode-directory": tmp.path },
          })
          expect(response.status).toBe(200)
          const body = (await response.json()) as any

          expect(body.securityRequirements).toEqual([
            {
              schemes: {
                spiffeBearer: { list: [] },
              },
            },
          ])
        },
      })
    })

    test("valid JWT-SVID with correct audience", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const skillDir = path.join(dir, ".opencode", "skills", "test-skill")
          await fs.mkdir(skillDir, { recursive: true })
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---
name: test-skill
description: Test skill
a2a:
  expose: true
  tags: ["test"]
---
Test skill.
`,
          )

          const agentDir = path.join(dir, ".opencode", "agents")
          await fs.mkdir(agentDir, { recursive: true })
          await Bun.write(
            path.join(agentDir, "spiffe-agent.md"),
            `---
name: spiffe-agent
description: SPIFFE-protected agent
mode: a2a
skills:
  - test-skill
a2a:
  baseUrl: https://example.test
  version: "1.0.0"
  auth: ["spiffe"]
  spiffe:
    audience: test-audience
    allowedIds:
      - spiffe://trust.domain/workload/*
---
SPIFFE agent.
`,
          )

          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              server: {
                a2a: {
                  enabled: true,
                  baseUrl: "https://example.test",
                },
              },
            }),
          )
        },
      })

      await Instance.disposeAll()
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          Env.set("ANTHROPIC_API_KEY", "test-key")
        },
        fn: async () => {
          const app = Server.App()

          // Mock SPIFFE verification to succeed
          const spiffeModule = await import("../../src/server/spiffe")
          const verifySpy = spyOn(spiffeModule, "verifySPIFFE").mockImplementation(
            async (token: string, audience: string, allowedIds?: string[]) => {
              if (token === "valid-jwt-svid" && audience === "test-audience") {
                return "spiffe://trust.domain/workload/test"
              }
              return false
            },
          )

          // Set required env vars
          process.env["SPIFFE_ENDPOINT_SOCKET"] = "unix:///tmp/spire-agent.sock"
          process.env["OPENCODE_SPIFFE_AUDIENCE"] = "default-audience"

          try {
            const response = await app.request("/a2a/spiffe-agent/tasks", {
              method: "GET",
              headers: {
                "x-opencode-directory": tmp.path,
                Authorization: "Bearer valid-jwt-svid",
              },
            })

            expect(response.status).toBe(200)
            expect(verifySpy).toHaveBeenCalledWith("valid-jwt-svid", "test-audience", ["spiffe://trust.domain/workload/*"])
          } finally {
            verifySpy.mockRestore()
            delete process.env["SPIFFE_ENDPOINT_SOCKET"]
            delete process.env["OPENCODE_SPIFFE_AUDIENCE"]
          }
        },
      })
    })

    test("valid JWT-SVID with wrong audience fails", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const skillDir = path.join(dir, ".opencode", "skills", "test-skill")
          await fs.mkdir(skillDir, { recursive: true })
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---
name: test-skill
description: Test skill
a2a:
  expose: true
  tags: ["test"]
---
Test.
`,
          )

          const agentDir = path.join(dir, ".opencode", "agents")
          await fs.mkdir(agentDir, { recursive: true })
          await Bun.write(
            path.join(agentDir, "spiffe-agent.md"),
            `---
name: spiffe-agent
mode: a2a
skills: [test-skill]
a2a:
  baseUrl: https://example.test
  auth: ["spiffe"]
  spiffe:
    audience: "correct-audience"
---
Agent.
`,
          )

          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              server: { a2a: { enabled: true } },
            }),
          )
        },
      })

      await Instance.disposeAll()
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          Env.set("ANTHROPIC_API_KEY", "test-key")
        },
        fn: async () => {
          const app = Server.App()

          const spiffeModule = await import("../../src/server/spiffe")
          const verifySpy = spyOn(spiffeModule, "verifySPIFFE").mockImplementation(
            async (token: string, audience: string) => {
              // Only succeeds with correct audience — returns SPIFFE ID or false
              if (audience === "correct-audience" && token === "valid-token") {
                return "spiffe://trust.domain/workload/test"
              }
              return false
            },
          )

      process.env["SPIFFE_ENDPOINT_SOCKET"] = "unix:///tmp/spire-agent.sock"
      process.env["OPENCODE_SPIFFE_AUDIENCE"] = "default-audience"

      try {
        // Token with wrong audience
        const response = await app.request("/a2a/spiffe-agent/tasks", {
          method: "GET",
          headers: {
            "x-opencode-directory": tmp.path,
            Authorization: "Bearer wrong-audience-token",
          },
        })

        expect(response.status).toBe(401)
      } finally {
        verifySpy.mockRestore()
        delete process.env["SPIFFE_ENDPOINT_SOCKET"]
        delete process.env["OPENCODE_SPIFFE_AUDIENCE"]
      }
        },
      })
    })

    test("no bearer token fails", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const skillDir = path.join(dir, ".opencode", "skills", "test-skill")
          await fs.mkdir(skillDir, { recursive: true })
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---
name: test-skill
description: Test skill
a2a:
  expose: true
  tags: ["test"]
---
Test.
`,
          )

          const agentDir = path.join(dir, ".opencode", "agents")
          await fs.mkdir(agentDir, { recursive: true })
          await Bun.write(
            path.join(agentDir, "spiffe-agent.md"),
            `---
name: spiffe-agent
mode: a2a
skills: [test-skill]
a2a:
  baseUrl: https://example.test
  auth: ["spiffe"]
---
Agent.
`,
          )

          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              server: { a2a: { enabled: true } },
            }),
          )
        },
      })

      await Instance.disposeAll()
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          Env.set("ANTHROPIC_API_KEY", "test-key")
        },
        fn: async () => {
          const app = Server.App()

          process.env["SPIFFE_ENDPOINT_SOCKET"] = "unix:///tmp/spire-agent.sock"
          process.env["OPENCODE_SPIFFE_AUDIENCE"] = "test-audience"

          try {
            const response = await app.request("/a2a/spiffe-agent/tasks", {
              method: "GET",
              headers: {
                "x-opencode-directory": tmp.path,
                // No Authorization header
              },
            })

            expect(response.status).toBe(401)
          } finally {
            delete process.env["SPIFFE_ENDPOINT_SOCKET"]
            delete process.env["OPENCODE_SPIFFE_AUDIENCE"]
          }
        },
      })
    })

    test("per-agent audience override works", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const skillDir = path.join(dir, ".opencode", "skills", "test-skill")
          await fs.mkdir(skillDir, { recursive: true })
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---
name: test-skill
description: Test skill
a2a:
  expose: true
  tags: ["test"]
---
Test.
`,
          )

          const agentDir = path.join(dir, ".opencode", "agents")
          await fs.mkdir(agentDir, { recursive: true })
          await Bun.write(
            path.join(agentDir, "spiffe-agent.md"),
            `---
name: spiffe-agent
mode: a2a
skills: [test-skill]
a2a:
  baseUrl: https://example.test
  auth: ["spiffe"]
  spiffe:
    audience: "agent-specific-audience"
---
Agent.
`,
          )

          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              server: { a2a: { enabled: true } },
            }),
          )
        },
      })

      await Instance.disposeAll()
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          Env.set("ANTHROPIC_API_KEY", "test-key")
        },
        fn: async () => {
          const app = Server.App()

          const spiffeModule = await import("../../src/server/spiffe")
          const verifySpy = spyOn(spiffeModule, "verifySPIFFE").mockImplementation(
            async (token: string, audience: string) => {
              if (audience === "agent-specific-audience" && token === "valid-token") {
                return "spiffe://trust.domain/workload/test"
              }
              return false
            },
          )

          process.env["SPIFFE_ENDPOINT_SOCKET"] = "unix:///tmp/spire-agent.sock"
          process.env["OPENCODE_SPIFFE_AUDIENCE"] = "default-audience"

          try {
            const response = await app.request("/a2a/spiffe-agent/tasks", {
              method: "GET",
              headers: {
                "x-opencode-directory": tmp.path,
                Authorization: "Bearer valid-token",
              },
            })

            expect(response.status).toBe(200)
            // Verify it used the agent-specific audience, not the global one
            expect(verifySpy).toHaveBeenCalledWith("valid-token", "agent-specific-audience", undefined)
          } finally {
            verifySpy.mockRestore()
            delete process.env["SPIFFE_ENDPOINT_SOCKET"]
            delete process.env["OPENCODE_SPIFFE_AUDIENCE"]
          }
        },
      })
    })

    test("disallowed SPIFFE ID fails", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const skillDir = path.join(dir, ".opencode", "skills", "test-skill")
          await fs.mkdir(skillDir, { recursive: true })
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---
name: test-skill
description: Test skill
a2a:
  expose: true
  tags: ["test"]
---
Test.
`,
          )

          const agentDir = path.join(dir, ".opencode", "agents")
          await fs.mkdir(agentDir, { recursive: true })
          await Bun.write(
            path.join(agentDir, "spiffe-agent.md"),
            `---
name: spiffe-agent
mode: a2a
skills: [test-skill]
a2a:
  baseUrl: https://example.test
  auth: ["spiffe"]
  spiffe:
    audience: "test-audience"
    allowedIds: ["spiffe://trust.domain/allowed/*"]
---
Agent.
`,
          )

          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              server: { a2a: { enabled: true } },
            }),
          )
        },
      })

      await Instance.disposeAll()
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          Env.set("ANTHROPIC_API_KEY", "test-key")
        },
        fn: async () => {
          const app = Server.App()

          const spiffeModule = await import("../../src/server/spiffe")
          const verifySpy = spyOn(spiffeModule, "verifySPIFFE").mockImplementation(
            async (token: string, audience: string, allowedIds?: string[]) => {
              // Simulate SPIFFE ID check failure
              return false
            },
          )

          process.env["SPIFFE_ENDPOINT_SOCKET"] = "unix:///tmp/spire-agent.sock"
          process.env["OPENCODE_SPIFFE_AUDIENCE"] = "default-audience"

          try {
            const response = await app.request("/a2a/spiffe-agent/tasks", {
              method: "GET",
              headers: {
                "x-opencode-directory": tmp.path,
                Authorization: "Bearer disallowed-id-token",
              },
            })

            expect(response.status).toBe(401)
            expect(verifySpy).toHaveBeenCalledWith(
              "disallowed-id-token",
              "test-audience",
              ["spiffe://trust.domain/allowed/*"],
            )
          } finally {
            verifySpy.mockRestore()
            delete process.env["SPIFFE_ENDPOINT_SOCKET"]
            delete process.env["OPENCODE_SPIFFE_AUDIENCE"]
          }
        },
      })
    })

    test("SPIRE Agent unavailable fails closed", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const skillDir = path.join(dir, ".opencode", "skills", "test-skill")
          await fs.mkdir(skillDir, { recursive: true })
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---
name: test-skill
description: Test skill
a2a:
  expose: true
  tags: ["test"]
---
Test.
`,
          )

          const agentDir = path.join(dir, ".opencode", "agents")
          await fs.mkdir(agentDir, { recursive: true })
          await Bun.write(
            path.join(agentDir, "spiffe-agent.md"),
            `---
name: spiffe-agent
mode: a2a
skills: [test-skill]
a2a:
  baseUrl: https://example.test
  auth: ["spiffe"]
---
Agent.
`,
          )

          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              server: { a2a: { enabled: true } },
            }),
          )
        },
      })

      await Instance.disposeAll()
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          Env.set("ANTHROPIC_API_KEY", "test-key")
        },
        fn: async () => {
          const app = Server.App()

          const spiffeModule = await import("../../src/server/spiffe")
          const verifySpy = spyOn(spiffeModule, "verifySPIFFE").mockImplementation(async () => {
            // Simulate SPIRE Agent connection failure
            throw new Error("Connection to SPIRE Agent failed")
          })

          process.env["SPIFFE_ENDPOINT_SOCKET"] = "unix:///tmp/spire-agent.sock"
          process.env["OPENCODE_SPIFFE_AUDIENCE"] = "test-audience"

          try {
            const response = await app.request("/a2a/spiffe-agent/tasks", {
              method: "GET",
              headers: {
                "x-opencode-directory": tmp.path,
                Authorization: "Bearer valid-token",
              },
            })

            // Should fail closed (401) when SPIRE is unavailable
            expect(response.status).toBe(401)
          } finally {
            verifySpy.mockRestore()
            delete process.env["SPIFFE_ENDPOINT_SOCKET"]
            delete process.env["OPENCODE_SPIFFE_AUDIENCE"]
          }
        },
      })
    })
  })

  describe("a2a.authz plugin hook", () => {
    // Project fixture: server-level plugin authz enabled, no real plugin file needed
    // (hook is intercepted via spyOn(Plugin, "trigger"))
    async function projectWithPluginAuthz(opts?: { statusOnError?: number; exposeDenyReason?: boolean }) {
      return tmpdir({
        init: async (dir) => {
          const skillDir = path.join(dir, ".opencode", "skills", "sidecar-preserve")
          await fs.mkdir(skillDir, { recursive: true })
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---
name: sidecar-preserve
description: Build and preserve the sidecar container image
a2a:
  expose: true
  tags: ["docker", "build"]
---
Skill body.
`,
          )

          const agentDir = path.join(dir, ".opencode", "agents")
          await fs.mkdir(agentDir, { recursive: true })
          await Bun.write(
            path.join(agentDir, "neo-sidecar.md"),
            `---
name: neo-sidecar
description: AI-powered container build and deployment agent
mode: a2a
skills:
  - sidecar-preserve
a2a:
  baseUrl: https://example.test
  auth: ["api-key"]
---
You are a container build agent.
`,
          )

          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              server: {
                a2a: {
                  enabled: true,
                  baseUrl: "https://example.test",
                  auth: ["api-key"],
                authz: {
                  provider: "plugin",
                  ...(typeof opts?.exposeDenyReason === "boolean"
                    ? { exposeDenyReason: opts.exposeDenyReason }
                    : {}),
                  plugin: {
                    id: "test-authz",
                    policy: { realm: "test" },
                    ...(typeof opts?.statusOnError === "number" ? { statusOnError: opts.statusOnError } : {}),
                  },
                },
              },
              },
            }),
          )
        },
      })
    }

    test("deny decision returns 403", async () => {
      await using tmp = await projectWithPluginAuthz()
      await Instance.disposeAll()
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          Env.set("ANTHROPIC_API_KEY", "test-key")
        },
        fn: async () => {
          const spy = spyOn(Plugin, "trigger").mockImplementation(async (name: any, _input: any, output: any) => {
            if (name === "a2a.authz") output.decision = { allow: false, reason: "policy_denied" }
            return output
          })
          try {
            const app = Server.App()
            const response = await app.request("/a2a/neo-sidecar/tasks", {
              method: "GET",
              headers: { "x-opencode-directory": tmp.path, ...AUTH_HEADER },
            })
            expect(response.status).toBe(403)
            const body = (await response.json()) as any
            expect(body.error.code).toBe("Forbidden")
          } finally {
            spy.mockRestore()
          }
        },
      })
    }, 10000)

    test("deny status_code 401 is normalized to 403 after authentication", async () => {
      await using tmp = await projectWithPluginAuthz()
      await Instance.disposeAll()
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          Env.set("ANTHROPIC_API_KEY", "test-key")
        },
        fn: async () => {
          const spy = spyOn(Plugin, "trigger").mockImplementation(async (name: any, _input: any, output: any) => {
            if (name === "a2a.authz") output.decision = { allow: false, status_code: 401, reason: "bad_token" }
            return output
          })
          try {
            const app = Server.App()
            const response = await app.request("/a2a/neo-sidecar/tasks", {
              method: "GET",
              headers: { "x-opencode-directory": tmp.path, ...AUTH_HEADER },
            })
            expect(response.status).toBe(403)
          } finally {
            spy.mockRestore()
          }
        },
      })
    }, 10000)

    test("hook throw fails closed with 403", async () => {
      await using tmp = await projectWithPluginAuthz()
      await Instance.disposeAll()
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          Env.set("ANTHROPIC_API_KEY", "test-key")
        },
        fn: async () => {
          const spy = spyOn(Plugin, "trigger").mockImplementation(async (name: any, _input: any, output: any) => {
            if (name === "a2a.authz") throw new Error("authz hook failed")
            return output
          })
          try {
            const app = Server.App()
            const response = await app.request("/a2a/neo-sidecar/tasks", {
              method: "GET",
              headers: { "x-opencode-directory": tmp.path, ...AUTH_HEADER },
            })
            expect(response.status).toBe(403)
          } finally {
            spy.mockRestore()
          }
        },
      })
    }, 10000)

    test("hook throw honors plugin statusOnError override", async () => {
      await using tmp = await projectWithPluginAuthz({ statusOnError: 503 })
      await Instance.disposeAll()
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          Env.set("ANTHROPIC_API_KEY", "test-key")
        },
        fn: async () => {
          const spy = spyOn(Plugin, "trigger").mockImplementation(async (name: any, _input: any, output: any) => {
            if (name === "a2a.authz") throw new Error("authz hook failed")
            return output
          })
          try {
            const app = Server.App()
            const response = await app.request("/a2a/neo-sidecar/tasks", {
              method: "GET",
              headers: { "x-opencode-directory": tmp.path, ...AUTH_HEADER },
            })
            expect(response.status).toBe(503)
          } finally {
            spy.mockRestore()
          }
        },
      })
    }, 10000)

    test("hook timeout fails closed with default status", async () => {
      await using tmp = await projectWithPluginAuthz()
      await Instance.disposeAll()
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          Env.set("ANTHROPIC_API_KEY", "test-key")
          Env.set("OPENCODE_A2A_PLUGIN_AUTHZ_TIMEOUT_MS", "50")
        },
        fn: async () => {
          const spy = spyOn(Plugin, "trigger").mockImplementation(async (name: any, _input: any, output: any) => {
            if (name === "a2a.authz") {
              await new Promise(() => {})
            }
            return output
          })
          try {
            const app = Server.App()
            const response = await app.request("/a2a/neo-sidecar/tasks", {
              method: "GET",
              headers: { "x-opencode-directory": tmp.path, ...AUTH_HEADER },
            })
            expect(response.status).toBe(403)
          } finally {
            spy.mockRestore()
          }
        },
      })
    }, 10000)

    test("hook timeout honors plugin statusOnError override", async () => {
      await using tmp = await projectWithPluginAuthz({ statusOnError: 503 })
      await Instance.disposeAll()
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          Env.set("ANTHROPIC_API_KEY", "test-key")
          Env.set("OPENCODE_A2A_PLUGIN_AUTHZ_TIMEOUT_MS", "50")
        },
        fn: async () => {
          const spy = spyOn(Plugin, "trigger").mockImplementation(async (name: any, _input: any, output: any) => {
            if (name === "a2a.authz") {
              await new Promise(() => {})
            }
            return output
          })
          try {
            const app = Server.App()
            const response = await app.request("/a2a/neo-sidecar/tasks", {
              method: "GET",
              headers: { "x-opencode-directory": tmp.path, ...AUTH_HEADER },
            })
            expect(response.status).toBe(503)
          } finally {
            spy.mockRestore()
          }
        },
      })
    }, 10000)

    test("default deny response hides provider reason", async () => {
      await using tmp = await projectWithPluginAuthz()
      await Instance.disposeAll()
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          Env.set("ANTHROPIC_API_KEY", "test-key")
        },
        fn: async () => {
          const spy = spyOn(Plugin, "trigger").mockImplementation(async (name: any, _input: any, output: any) => {
            if (name === "a2a.authz") output.decision = { allow: false, reason: "policy_denied" }
            return output
          })
          try {
            const app = Server.App()
            const response = await app.request("/a2a/neo-sidecar/tasks", {
              method: "GET",
              headers: { "x-opencode-directory": tmp.path, ...AUTH_HEADER },
            })
            expect(response.status).toBe(403)
            const body = (await response.json()) as any
            expect(body.error.message).toBe("Authorization denied")
          } finally {
            spy.mockRestore()
          }
        },
      })
    }, 10000)

    test("exposeDenyReason returns provider reason to caller", async () => {
      await using tmp = await projectWithPluginAuthz({ exposeDenyReason: true })
      await Instance.disposeAll()
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          Env.set("ANTHROPIC_API_KEY", "test-key")
        },
        fn: async () => {
          const spy = spyOn(Plugin, "trigger").mockImplementation(async (name: any, _input: any, output: any) => {
            if (name === "a2a.authz") output.decision = { allow: false, reason: "policy_denied" }
            return output
          })
          try {
            const app = Server.App()
            const response = await app.request("/a2a/neo-sidecar/tasks", {
              method: "GET",
              headers: { "x-opencode-directory": tmp.path, ...AUTH_HEADER },
            })
            expect(response.status).toBe(403)
            const body = (await response.json()) as any
            expect(body.error.message).toBe("policy_denied")
          } finally {
            spy.mockRestore()
          }
        },
      })
    }, 10000)

    test("allow decision passes request through", async () => {
      await using tmp = await projectWithPluginAuthz()
      await Instance.disposeAll()
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          Env.set("ANTHROPIC_API_KEY", "test-key")
        },
        fn: async () => {
          const spy = spyOn(Plugin, "trigger").mockImplementation(async (name: any, _input: any, output: any) => {
            if (name === "a2a.authz") output.decision = { allow: true }
            return output
          })
          try {
            const app = Server.App()
            const response = await app.request("/a2a/neo-sidecar/tasks", {
              method: "GET",
              headers: { "x-opencode-directory": tmp.path, ...AUTH_HEADER },
            })
            expect(response.status).not.toBe(403)
            expect(response.status).not.toBe(401)
          } finally {
            spy.mockRestore()
          }
        },
      })
    }, 10000)

    test("undefined decision fails closed", async () => {
      await using tmp = await projectWithPluginAuthz()
      await Instance.disposeAll()
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          Env.set("ANTHROPIC_API_KEY", "test-key")
        },
        fn: async () => {
          const spy = spyOn(Plugin, "trigger").mockImplementation(async (_name: any, _input: any, output: any) => {
            // leave output.decision undefined — runtime must fail closed
            return output
          })
          try {
            const app = Server.App()
            const response = await app.request("/a2a/neo-sidecar/tasks", {
              method: "GET",
              headers: { "x-opencode-directory": tmp.path, ...AUTH_HEADER },
            })
            expect(response.status).toBe(403)
          } finally {
            spy.mockRestore()
          }
        },
      })
    }, 10000)

    test("per-agent plugin authz is enforced in discovery listing", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "agent", "neo-sidecar.md"),
            `---
name: neo-sidecar
description: test agent
mode: subagent
model: anthropic/claude-3-5-haiku-latest
---

You are a test agent.
`,
          )
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              server: {
                a2a: {
                  enabled: true,
                  baseUrl: "https://example.test",
                  auth: ["api-key"],
                },
              },
              agent: {
                "neo-sidecar": {
                  mode: "subagent",
                  description: "test agent",
                  prompt: "You are a test agent.",
                  model: "anthropic/claude-3-5-haiku-latest",
                  a2a: {
                    authz: {
                      provider: "plugin",
                      plugin: {
                        id: "test-authz",
                        policy: { realm: "test" },
                      },
                    },
                  },
                },
              },
            }),
          )
        },
      })
      await Instance.disposeAll()
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          Env.set("ANTHROPIC_API_KEY", "test-key")
          Env.set("OPENCODE_A2A_API_KEY", "test-a2a-key")
        },
        fn: async () => {
          const spy = spyOn(Plugin, "trigger").mockImplementation(async (_name: any, _input: any, output: any) => {
            // leave output.decision undefined — runtime must fail closed
            return output
          })
          try {
            const app = Server.App()
            const response = await app.request("/.well-known/agents.json", {
              headers: { "x-opencode-directory": tmp.path, "x-a2a-key": "test-a2a-key" },
            })
            expect(response.status).toBe(200)
            const body = (await response.json()) as any
            expect(body.agents).toHaveLength(0)
          } finally {
            spy.mockRestore()
          }
        },
      })
    }, 10000)

    test("fails closed when per-agent authz config lookup errors", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "agent", "neo-sidecar.md"),
            `---
name: neo-sidecar
description: test agent
mode: subagent
model: anthropic/claude-3-5-haiku-latest
---

You are a test agent.
`,
          )
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              server: {
                a2a: {
                  enabled: true,
                  baseUrl: "https://example.test",
                  auth: ["api-key"],
                },
              },
              agent: {
                "neo-sidecar": {
                  mode: "subagent",
                  description: "test agent",
                  prompt: "You are a test agent.",
                  model: "anthropic/claude-3-5-haiku-latest",
                  a2a: {
                    authz: {
                      provider: "plugin",
                      plugin: {
                        id: "test-authz",
                        policy: { realm: "test" },
                      },
                    },
                  },
                },
              },
            }),
          )
        },
      })
      await Instance.disposeAll()
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          Env.set("ANTHROPIC_API_KEY", "test-key")
          Env.set("OPENCODE_A2A_API_KEY", "test-a2a-key")
        },
        fn: async () => {
          const base = Agent.get.bind(Agent)
          const spy = spyOn(Agent, "get").mockImplementation(async (id: string) => {
            if (id === "neo-sidecar") throw new Error("agent config read failed")
            return base(id as any)
          })
          try {
            const app = Server.App()
            const listing = await app.request("/.well-known/agents.json", {
              headers: { "x-opencode-directory": tmp.path, "x-a2a-key": "test-a2a-key" },
            })
            expect(listing.status).toBe(200)
            const body = (await listing.json()) as any
            expect(body.agents).toHaveLength(0)
          } finally {
            spy.mockRestore()
          }
        },
      })
    }, 10000)

    test("discovery respects per-agent plugin authz even when server ext_authz is fail-open", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "agent", "neo-sidecar.md"),
            `---
name: neo-sidecar
description: test agent
mode: subagent
model: anthropic/claude-3-5-haiku-latest
---

You are a test agent.
`,
          )
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              server: {
                a2a: {
                  enabled: true,
                  baseUrl: "https://example.test",
                  auth: ["api-key"],
                  authz: {
                    provider: "ext_authz",
                    extAuthz: {
                      endpoint: "grpc://127.0.0.1:1",
                      timeout: 50,
                      failOpen: true,
                    },
                  },
                },
              },
              agent: {
                "neo-sidecar": {
                  mode: "subagent",
                  description: "test agent",
                  prompt: "You are a test agent.",
                  model: "anthropic/claude-3-5-haiku-latest",
                  a2a: {
                    authz: {
                      provider: "plugin",
                      plugin: {
                        id: "test-authz",
                        policy: { realm: "test" },
                      },
                    },
                  },
                },
              },
            }),
          )
        },
      })
      await Instance.disposeAll()
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          Env.set("ANTHROPIC_API_KEY", "test-key")
          Env.set("OPENCODE_A2A_API_KEY", "test-a2a-key")
        },
        fn: async () => {
          const spy = spyOn(Plugin, "trigger").mockImplementation(async (name: any, input: any, output: any) => {
            if (name === "a2a.authz" && input.action === "view") {
              output.decision = { allow: false, reason: "view_denied" }
            }
            return output
          })
          try {
            const app = Server.App()
            const response = await app.request("/.well-known/agents.json", {
              headers: { "x-opencode-directory": tmp.path, "x-a2a-key": "test-a2a-key" },
            })
            expect(response.status).toBe(200)
            const body = (await response.json()) as any
            expect(body.agents).toHaveLength(0)
          } finally {
            spy.mockRestore()
          }
        },
      })
    }, 10000)

    test("view deny hides agent from discovery listing", async () => {
      await using tmp = await projectWithPluginAuthz()
      await Instance.disposeAll()
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          Env.set("ANTHROPIC_API_KEY", "test-key")
        },
        fn: async () => {
          const spy = spyOn(Plugin, "trigger").mockImplementation(async (name: any, input: any, output: any) => {
            if (name === "a2a.authz" && input.action === "view")
              output.decision = { allow: false, reason: "view_denied" }
            return output
          })
          try {
            const app = Server.App()
            const response = await app.request("/.well-known/agents.json", {
              headers: { "x-opencode-directory": tmp.path, ...AUTH_HEADER },
            })
            expect(response.status).toBe(200)
            const body = (await response.json()) as any
            expect(body.agents).toHaveLength(0)
          } finally {
            spy.mockRestore()
          }
        },
      })
    }, 10000)

    test("view deny returns 404 on per-agent card endpoint", async () => {
      await using tmp = await projectWithPluginAuthz()
      await Instance.disposeAll()
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          Env.set("ANTHROPIC_API_KEY", "test-key")
        },
        fn: async () => {
          const spy = spyOn(Plugin, "trigger").mockImplementation(async (name: any, input: any, output: any) => {
            if (name === "a2a.authz" && input.action === "view")
              output.decision = { allow: false, reason: "view_denied" }
            return output
          })
          try {
            const app = Server.App()
            const response = await app.request("/.well-known/agents/neo-sidecar/card.json", {
              headers: { "x-opencode-directory": tmp.path, ...AUTH_HEADER },
            })
            // 404 not 403: prevents information leakage about agent existence
            expect(response.status).toBe(404)
          } finally {
            spy.mockRestore()
          }
        },
      })
    }, 10000)

    test("hook receives correct input fields", async () => {
      await using tmp = await projectWithPluginAuthz()
      await Instance.disposeAll()
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          Env.set("ANTHROPIC_API_KEY", "test-key")
        },
        fn: async () => {
          let captured: any
          const spy = spyOn(Plugin, "trigger").mockImplementation(async (name: any, input: any, output: any) => {
            if (name === "a2a.authz") {
              captured = input
              output.decision = { allow: true }
            }
            return output
          })
          try {
            const app = Server.App()
            await app.request("/a2a/neo-sidecar/tasks", {
              method: "GET",
              headers: { "x-opencode-directory": tmp.path, ...AUTH_HEADER },
            })
            expect(captured).toBeDefined()
            expect(captured.agent).toBe("neo-sidecar")
            expect(captured.action).toBe("invoke")
            expect(captured.method).toBe("GET")
            expect(typeof captured.path).toBe("string")
            expect(typeof captured.strategy).toBe("string")
            expect(typeof captured.headers).toBe("object")
            expect(captured.plugin.id).toBe("test-authz")
          } finally {
            spy.mockRestore()
          }
        },
      })
    }, 10000)

    test("credential headers are redacted in hook input", async () => {
      await using tmp = await projectWithPluginAuthz()
      await Instance.disposeAll()
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          Env.set("ANTHROPIC_API_KEY", "test-key")
        },
        fn: async () => {
          let captured: any
          const spy = spyOn(Plugin, "trigger").mockImplementation(async (name: any, input: any, output: any) => {
            if (name === "a2a.authz") {
              captured = input
              output.decision = { allow: true }
            }
            return output
          })
          try {
            const app = Server.App()
            await app.request("/a2a/neo-sidecar/tasks", {
              method: "GET",
              headers: {
                "x-opencode-directory": tmp.path,
                "Authorization": "Bearer super-secret",
                ...AUTH_HEADER,
              },
            })
            expect(captured).toBeDefined()
            const authVal =
              captured.headers["authorization"] ?? captured.headers["Authorization"]
            // Key may be present but value must be redacted
            if (authVal !== undefined) expect(authVal).not.toContain("super-secret")
          } finally {
            spy.mockRestore()
          }
        },
      })
    }, 10000)
  })
})
