// Set API key for server-level auth middleware
process.env["OPENCODE_TOOL_ENDPOINT_API_KEY"] = "test-a2a-key"

import { afterAll, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { createHmac } from "crypto"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Env } from "../../src/env"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { Config } from "../../src/config/config"
import { Plugin } from "../../src/plugin"

Log.init({ print: false })

const AUTH_HEADER = { "X-API-Key": "test-a2a-key" }

function encodeBase64url(input: string | Buffer) {
  const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : input
  return buffer.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")
}

function signHS256(payload: Record<string, unknown>, secret: string) {
  const header = { alg: "HS256", typ: "JWT" }
  const encodedHeader = encodeBase64url(JSON.stringify(header))
  const encodedPayload = encodeBase64url(JSON.stringify(payload))
  const signingInput = `${encodedHeader}.${encodedPayload}`
  const signature = createHmac("sha256", secret).update(signingInput, "utf8").digest()
  return `${signingInput}.${encodeBase64url(signature)}`
}

// Clean up env var so it doesn't bleed into other test files
afterAll(() => {
  delete process.env["OPENCODE_TOOL_ENDPOINT_API_KEY"]
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
                  name: "X-API-Key",
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

        // Standard path with multiple agents should return listing
        const response = await app.request("/.well-known/agent-card.json", {
          headers: { "x-opencode-directory": tmp.path },
        })
        expect(response.status).toBe(200)
        const body = (await response.json()) as any
        expect(body.message).toContain("Multiple A2A agents")
        expect(body.agents).toHaveLength(2)

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
        // No X-API-Key header — server middleware rejects
        const response = await app.request("/a2a/neo-sidecar/tasks", {
          method: "GET",
          headers: {
            "x-opencode-directory": tmp.path,
          },
        })
        expect(response.status).toBe(401)
        const body = (await response.json()) as any
        expect(body.error).toBe("Unauthorized")
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
            "X-API-Key": "wrong-key",
          },
        })
        expect(response.status).toBe(401)
        const body = (await response.json()) as any
        expect(body.error).toBe("Unauthorized")
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

  test("auth: server-level API key protects all agents regardless of agent auth config", async () => {
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
          path.join(agentDir, "open-agent.md"),
          `---
name: open-agent
description: Public agent with no auth
mode: a2a
skills:
  - open-skill
a2a:
  baseUrl: https://example.test
  version: "1.0.0"
---
You are a public agent.
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

        // Without API key — server middleware rejects (OPENCODE_TOOL_ENDPOINT_API_KEY is set globally)
        const noKeyResponse = await app.request("/a2a/open-agent/tasks", {
          method: "GET",
          headers: {
            "x-opencode-directory": tmp.path,
          },
        })
        expect(noKeyResponse.status).toBe(401)

        // With API key — server middleware passes
        const withKeyResponse = await app.request("/a2a/open-agent/tasks", {
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
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const previousSecret = process.env.OPENCODE_COMPAT_JWT_HS256_SECRET
        const previousIssuer = process.env.OPENCODE_COMPAT_JWT_ISSUER
        const previousAudience = process.env.OPENCODE_COMPAT_JWT_AUDIENCE
        try {
          Env.set("OPENCODE_COMPAT_JWT_HS256_SECRET", "a2a-jwt-secret")
          Env.set("OPENCODE_COMPAT_JWT_ISSUER", "a2a-issuer")
          Env.set("OPENCODE_COMPAT_JWT_AUDIENCE", "a2a-audience")

          const app = Server.App()
          const goodToken = signHS256(
            { exp: Math.floor(Date.now() / 1000) + 120, iss: "a2a-issuer", aud: "a2a-audience" },
            "a2a-jwt-secret",
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
        } finally {
          if (previousSecret === undefined) delete process.env.OPENCODE_COMPAT_JWT_HS256_SECRET
          else process.env.OPENCODE_COMPAT_JWT_HS256_SECRET = previousSecret
          if (previousIssuer === undefined) delete process.env.OPENCODE_COMPAT_JWT_ISSUER
          else process.env.OPENCODE_COMPAT_JWT_ISSUER = previousIssuer
          if (previousAudience === undefined) delete process.env.OPENCODE_COMPAT_JWT_AUDIENCE
          else process.env.OPENCODE_COMPAT_JWT_AUDIENCE = previousAudience
        }
      },
    })
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
        expect(body.error).toBe("Unauthorized")
      },
    })
  })

  test("auth: empty server.a2a.auth does not make protected routes public", async () => {
    await using tmp = await projectWithServerA2AAuth(true, [])
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const app = Server.App()

        const noAuth = await app.request("/a2a/neo-sidecar/tasks", {
          method: "GET",
          headers: { "x-opencode-directory": tmp.path },
        })
        expect(noAuth.status).toBe(401)

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
})
