import { describe, expect, test } from "bun:test"
import path from "path"
import { createHmac, createPublicKey, createSign, generateKeyPairSync } from "crypto"
import { createServer } from "http"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Env } from "../../src/env"
import { Log } from "../../src/util/log"

Log.init({ print: false })

async function project(auth: "api-key" | "plugin" | "jwt" | "oidc" | "oauth2", extra?: Record<string, unknown>) {
  return tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          server: {
            toolEndpoint: {
              enabled: true,
              auth,
              allowedTools: ["missing_tool"],
              ...(extra ?? {}),
            },
          },
        }),
      )
    },
  })
}

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

async function withEnv(vars: Record<string, string>, fn: () => Promise<void>) {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key])
    Env.set(key, value)
  }
  try {
    await fn()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function createSession(app: ReturnType<typeof Server.App>, directory: string, headers?: Record<string, string>) {
  const response = await app.request("/session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opencode-directory": directory,
      ...(headers ?? {}),
    },
    body: "{}",
  })
  expect(response.status).toBe(200)
  const body = (await response.json()) as { id: string }
  return body.id
}

async function invokeTool(
  app: ReturnType<typeof Server.App>,
  directory: string,
  sessionID: string,
  headers?: Record<string, string>,
  toolName = "missing_tool",
) {
  return app.request(`/tool/${toolName}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opencode-directory": directory,
      ...(headers ?? {}),
    },
    body: JSON.stringify({ sessionID, args: {} }),
  })
}

describe("tool endpoint auth policy", () => {
  test("jwt strategy authorizes valid bearer and rejects invalid bearer even with x-api-key", async () => {
    await using tmp = await project("jwt")
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await withEnv(
          {
            OPENCODE_COMPAT_JWT_HS256_SECRET: "jwt-secret",
            OPENCODE_COMPAT_JWT_ISSUER: "issuer-jwt",
            OPENCODE_COMPAT_JWT_AUDIENCE: "aud-jwt",
            OPENCODE_TOOL_ENDPOINT_API_KEY: "still-not-used",
          },
          async () => {
            const app = Server.App()
            const sessionID = await createSession(app, tmp.path, { "x-api-key": "still-not-used" })

            const goodToken = signHS256(
              { exp: Math.floor(Date.now() / 1000) + 120, iss: "issuer-jwt", aud: "aud-jwt" },
              "jwt-secret",
            )
            const allowed = await invokeTool(app, tmp.path, sessionID, {
              authorization: `Bearer ${goodToken}`,
            })
            expect(allowed.status).toBe(404)

            const denied = await invokeTool(app, tmp.path, sessionID, {
              authorization: "Bearer not-a-jwt",
              "x-api-key": "still-not-used",
            })
            expect(denied.status).toBe(401)
          },
        )
      },
    })
  })

  test("oidc strategy strictly validates via discovery jwks", async () => {
    await using tmp = await project("oidc")
    await Instance.disposeAll()

    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { format: "pem", type: "spki" },
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
    })
    const kid = "oidc-kid"
    const jwk = createPublicKey(publicKey).export({ format: "jwk" }) as Record<string, unknown>
    let issuer = ""
    const oidc = createServer((req, res) => {
      if (req.url === "/.well-known/openid-configuration") {
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }))
        return
      }
      if (req.url === "/jwks") {
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({ keys: [{ ...jwk, use: "sig", alg: "RS256", kid }] }))
        return
      }
      res.statusCode = 404
      res.end()
    })
    await new Promise<void>((resolve) => oidc.listen(0, "127.0.0.1", () => resolve()))
    try {
      const address = oidc.address()
      if (!address || typeof address === "string") throw new Error("failed to start oidc server")
      issuer = `http://127.0.0.1:${address.port}`

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await withEnv(
            {
              OPENCODE_COMPAT_OIDC_ISSUER: issuer,
              OPENCODE_COMPAT_OIDC_AUDIENCE: "aud-oidc-tool",
            },
            async () => {
              const app = Server.App()
              const sessionID = await createSession(app, tmp.path)
              const goodToken = signRS256(
                { exp: Math.floor(Date.now() / 1000) + 120, iss: issuer, aud: "aud-oidc-tool" },
                privateKey,
                kid,
              )

              const ok = await invokeTool(app, tmp.path, sessionID, {
                authorization: `Bearer ${goodToken}`,
              })
              expect(ok.status).toBe(404)

              const denied = await invokeTool(app, tmp.path, sessionID, {
                authorization: "Bearer opaque-token",
              })
              expect(denied.status).toBe(401)
            },
          )
        },
      })
    } finally {
      await new Promise<void>((resolve, reject) => oidc.close((error) => (error ? reject(error) : resolve())))
    }
  })

  test("oauth2 strategy strictly validates via introspection", async () => {
    await using tmp = await project("oauth2")
    await Instance.disposeAll()

    const introspection = createServer((req, res) => {
      if (req.url !== "/introspect") {
        res.statusCode = 404
        res.end()
        return
      }
      let body = ""
      req.on("data", (chunk) => {
        body += chunk.toString("utf8")
      })
      req.on("end", () => {
        const token = new URLSearchParams(body).get("token")
        res.setHeader("content-type", "application/json")
        if (token !== "opaque-allowed") {
          res.end(JSON.stringify({ active: false }))
          return
        }
        res.end(
          JSON.stringify({
            active: true,
            iss: "https://issuer.oauth2.tool",
            aud: ["aud-oauth2-tool"],
            scope: "tool.invoke",
            exp: Math.floor(Date.now() / 1000) + 120,
          }),
        )
      })
    })
    await new Promise<void>((resolve) => introspection.listen(0, "127.0.0.1", () => resolve()))
    try {
      const address = introspection.address()
      if (!address || typeof address === "string") throw new Error("failed to start introspection server")
      const introspectionURL = `http://127.0.0.1:${address.port}/introspect`

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await withEnv(
            {
              OPENCODE_COMPAT_OAUTH_INTROSPECTION_URL: introspectionURL,
              OPENCODE_COMPAT_OAUTH_CLIENT_ID: "tool-client",
              OPENCODE_COMPAT_OAUTH_CLIENT_SECRET: "tool-secret",
              OPENCODE_COMPAT_OAUTH_ISSUER: "https://issuer.oauth2.tool",
              OPENCODE_COMPAT_OAUTH_AUDIENCE: "aud-oauth2-tool",
              OPENCODE_COMPAT_OAUTH_REQUIRED_SCOPE: "tool.invoke",
            },
            async () => {
              const app = Server.App()
              const sessionID = await createSession(app, tmp.path)

              const ok = await invokeTool(app, tmp.path, sessionID, {
                authorization: "Bearer opaque-allowed",
              })
              expect(ok.status).toBe(404)

              const denied = await invokeTool(app, tmp.path, sessionID, {
                authorization: "Bearer opaque-denied",
              })
              expect(denied.status).toBe(401)
            },
          )
        },
      })
    } finally {
      await new Promise<void>((resolve, reject) =>
        introspection.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })

  test("plugin strategy remains fail-closed in centralized auth policy", async () => {
    await using tmp = await project("plugin")
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.App()
        const sessionID = await createSession(app, tmp.path)
        const response = await invokeTool(app, tmp.path, sessionID)
        expect(response.status).toBe(401)
      },
    })
  })

  test("tool allowlist and sensitive checks are unchanged", async () => {
    await using tmp = await project("jwt", {
      allowedTools: ["missing_tool", "bash"],
    })
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await withEnv(
          {
            OPENCODE_COMPAT_JWT_HS256_SECRET: "jwt-secret-allowlist",
            OPENCODE_COMPAT_JWT_ISSUER: "issuer-allowlist",
            OPENCODE_COMPAT_JWT_AUDIENCE: "aud-allowlist",
          },
          async () => {
          const app = Server.App()
          const sessionID = await createSession(app, tmp.path)
          const token = signHS256(
            { exp: Math.floor(Date.now() / 1000) + 120, iss: "issuer-allowlist", aud: "aud-allowlist" },
            "jwt-secret-allowlist",
          )

          const disallowed = await invokeTool(
            app,
            tmp.path,
            sessionID,
            { authorization: `Bearer ${token}` },
            "not_allowed",
          )
          expect(disallowed.status).toBe(403)

          const sensitive = await invokeTool(
            app,
            tmp.path,
            sessionID,
            { authorization: `Bearer ${token}` },
            "bash",
          )
          expect(sensitive.status).toBe(403)
          },
        )
      },
    })
  })
})
