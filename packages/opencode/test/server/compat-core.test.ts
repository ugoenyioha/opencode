import { describe, expect, test } from "bun:test"
import path from "path"
import { createSign, generateKeyPairSync, createPublicKey, createHmac } from "crypto"
import { createServer } from "http"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Env } from "../../src/env"
import { Log } from "../../src/util/log"

Log.init({ print: false })

async function project(config: Record<string, unknown>) {
  return tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          ...config,
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

describe("compat core routes", () => {
  test("returns 404 when compat providers are disabled", async () => {
    await using tmp = await project({
      server: {
        compat: {
          openai: { enabled: false },
          anthropic: { enabled: false },
        },
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
        expect((await app.request("/v1/models", { headers: { "x-opencode-directory": tmp.path } })).status).toBe(404)
        expect(
          (
            await app.request("/v1/messages", {
              method: "POST",
              headers: { "x-opencode-directory": tmp.path },
              body: "{}",
            })
          ).status,
        ).toBe(404)
      },
    })
  })

  test("openai requires bearer auth", async () => {
    await using tmp = await project({
      server: {
        compat: {
          openai: {
            enabled: true,
          },
        },
      },
    })
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Env.set("OPENCODE_TOOL_ENDPOINT_API_KEY", "test-token")
        const app = Server.App()
        const response = await app.request("/v1/models", {
          headers: { "x-opencode-directory": tmp.path },
        })
        expect(response.status).toBe(401)
        expect(await response.json()).toEqual({
          error: {
            type: "authentication_error",
            message: "Unauthorized",
            code: "invalid_api_key",
          },
        })
      },
    })
  })

  test("openai accepts valid HS256 bearer jwt", async () => {
    await using tmp = await project({
      server: {
        compat: {
          openai: {
            enabled: true,
          },
        },
      },
    })
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const prevSecret = process.env.OPENCODE_COMPAT_JWT_HS256_SECRET
        const prevIssuer = process.env.OPENCODE_COMPAT_JWT_ISSUER
        const prevAudience = process.env.OPENCODE_COMPAT_JWT_AUDIENCE
        try {
          Env.set("OPENCODE_TOOL_ENDPOINT_API_KEY", "test-token")
          Env.set("OPENCODE_COMPAT_JWT_HS256_SECRET", "super-secret")
          const token = signHS256(
            { exp: Math.floor(Date.now() / 1000) + 300, iss: "issuer-a", aud: "aud-a" },
            "super-secret",
          )
          Env.set("OPENCODE_COMPAT_JWT_ISSUER", "issuer-a")
          Env.set("OPENCODE_COMPAT_JWT_AUDIENCE", "aud-a")
          const app = Server.App()
          const response = await app.request("/v1/models", {
            headers: {
              authorization: `Bearer ${token}`,
              "x-opencode-directory": tmp.path,
            },
          })
          expect(response.status).toBe(200)
        } finally {
          if (prevSecret === undefined) delete process.env.OPENCODE_COMPAT_JWT_HS256_SECRET
          else process.env.OPENCODE_COMPAT_JWT_HS256_SECRET = prevSecret
          if (prevIssuer === undefined) delete process.env.OPENCODE_COMPAT_JWT_ISSUER
          else process.env.OPENCODE_COMPAT_JWT_ISSUER = prevIssuer
          if (prevAudience === undefined) delete process.env.OPENCODE_COMPAT_JWT_AUDIENCE
          else process.env.OPENCODE_COMPAT_JWT_AUDIENCE = prevAudience
        }
      },
    })
  })

  test("openai accepts valid RS256 bearer jwt via jwks", async () => {
    await using tmp = await project({
      server: {
        compat: {
          openai: {
            enabled: true,
          },
        },
      },
    })
    await Instance.disposeAll()
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { format: "pem", type: "spki" },
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
    })
    const kid = "kid-1"
    const jwk = createPublicKey(publicKey).export({ format: "jwk" }) as Record<string, unknown>
    const server = createServer((req, res) => {
      if (req.url !== "/.well-known/jwks.json") {
        res.statusCode = 404
        res.end()
        return
      }
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ keys: [{ ...jwk, use: "sig", alg: "RS256", kid }] }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("failed to start jwks server")
      const jwksUrl = `http://127.0.0.1:${address.port}/.well-known/jwks.json`

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const prevJwks = process.env.OPENCODE_COMPAT_JWT_JWKS_URL
          const prevIssuer = process.env.OPENCODE_COMPAT_JWT_ISSUER
          const prevAudience = process.env.OPENCODE_COMPAT_JWT_AUDIENCE
          try {
            Env.set("OPENCODE_TOOL_ENDPOINT_API_KEY", "test-token")
            Env.set("OPENCODE_COMPAT_JWT_JWKS_URL", jwksUrl)
            const token = signRS256(
              { exp: Math.floor(Date.now() / 1000) + 300, iss: "issuer-rs", aud: "aud-rs" },
              privateKey,
              kid,
            )
            Env.set("OPENCODE_COMPAT_JWT_ISSUER", "issuer-rs")
            Env.set("OPENCODE_COMPAT_JWT_AUDIENCE", "aud-rs")
            const app = Server.App()
            const response = await app.request("/v1/models", {
              headers: {
                authorization: `Bearer ${token}`,
                "x-opencode-directory": tmp.path,
              },
            })
            expect(response.status).toBe(200)
          } finally {
            if (prevJwks === undefined) delete process.env.OPENCODE_COMPAT_JWT_JWKS_URL
            else process.env.OPENCODE_COMPAT_JWT_JWKS_URL = prevJwks
            if (prevIssuer === undefined) delete process.env.OPENCODE_COMPAT_JWT_ISSUER
            else process.env.OPENCODE_COMPAT_JWT_ISSUER = prevIssuer
            if (prevAudience === undefined) delete process.env.OPENCODE_COMPAT_JWT_AUDIENCE
            else process.env.OPENCODE_COMPAT_JWT_AUDIENCE = prevAudience
          }
        },
      })
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  })

  test("openai fails closed when bearer is invalid even with valid x-api-key", async () => {
    await using tmp = await project({
      server: {
        compat: {
          openai: {
            enabled: true,
          },
        },
      },
    })
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const prevSecret = process.env.OPENCODE_COMPAT_JWT_HS256_SECRET
        try {
          Env.set("OPENCODE_TOOL_ENDPOINT_API_KEY", "test-token")
          Env.set("OPENCODE_COMPAT_JWT_HS256_SECRET", "super-secret")
          const app = Server.App()
          const response = await app.request("/v1/models", {
            headers: {
              authorization: "Bearer not-a-jwt",
              "x-api-key": "test-token",
              "x-opencode-directory": tmp.path,
            },
          })
          expect(response.status).toBe(401)
        } finally {
          if (prevSecret === undefined) delete process.env.OPENCODE_COMPAT_JWT_HS256_SECRET
          else process.env.OPENCODE_COMPAT_JWT_HS256_SECRET = prevSecret
        }
      },
    })
  })

  test("openai accepts valid OIDC JWT via discovery", async () => {
    await using tmp = await project({
      server: {
        compat: {
          openai: {
            enabled: true,
          },
        },
      },
    })
    await Instance.disposeAll()
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { format: "pem", type: "spki" },
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
    })
    const kid = "oidc-kid-1"
    const jwk = createPublicKey(publicKey).export({ format: "jwk" }) as Record<string, unknown>
    let issuer = ""
    const server = createServer((req, res) => {
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
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("failed to start oidc server")
      issuer = `http://127.0.0.1:${address.port}`
      const token = signRS256(
        { exp: Math.floor(Date.now() / 1000) + 300, iss: issuer, aud: "aud-oidc" },
        privateKey,
        kid,
      )
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          Env.set("OPENCODE_COMPAT_OIDC_ISSUER", issuer)
          Env.set("OPENCODE_COMPAT_OIDC_AUDIENCE", "aud-oidc")
          Env.set("OPENCODE_TOOL_ENDPOINT_API_KEY", "test-token")
          const app = Server.App()
          const response = await app.request("/v1/models", {
            headers: {
              authorization: `Bearer ${token}`,
              "x-opencode-directory": tmp.path,
            },
          })
          expect(response.status).toBe(200)
        },
      })
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  })

  test("openai accepts opaque bearer via oauth introspection", async () => {
    await using tmp = await project({
      server: {
        compat: {
          openai: {
            enabled: true,
          },
        },
      },
    })
    await Instance.disposeAll()
    const server = createServer((req, res) => {
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
        if (token !== "opaque-token") {
          res.setHeader("content-type", "application/json")
          res.end(JSON.stringify({ active: false }))
          return
        }
        res.setHeader("content-type", "application/json")
        res.end(
          JSON.stringify({
            active: true,
            iss: "https://issuer.introspection",
            aud: ["aud-introspection"],
            scope: "profile compat.read",
            exp: Math.floor(Date.now() / 1000) + 120,
          }),
        )
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("failed to start introspection server")
      const introspectionUrl = `http://127.0.0.1:${address.port}/introspect`
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          Env.set("OPENCODE_COMPAT_OAUTH_INTROSPECTION_URL", introspectionUrl)
          Env.set("OPENCODE_COMPAT_OAUTH_CLIENT_ID", "client-id")
          Env.set("OPENCODE_COMPAT_OAUTH_CLIENT_SECRET", "client-secret")
          Env.set("OPENCODE_COMPAT_OAUTH_ISSUER", "https://issuer.introspection")
          Env.set("OPENCODE_COMPAT_OAUTH_AUDIENCE", "aud-introspection")
          Env.set("OPENCODE_COMPAT_OAUTH_REQUIRED_SCOPE", "compat.read compat.admin")
          Env.set("OPENCODE_TOOL_ENDPOINT_API_KEY", "test-token")
          const app = Server.App()
          const response = await app.request("/v1/models", {
            headers: {
              authorization: "Bearer opaque-token",
              "x-opencode-directory": tmp.path,
            },
          })
          expect(response.status).toBe(200)
        },
      })
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  })

  test("openai allows bearer-only auth when global api-key gate is set", async () => {
    await using tmp = await project({
      server: {
        compat: {
          openai: {
            enabled: true,
          },
        },
      },
    })
    await Instance.disposeAll()
    const server = createServer((req, res) => {
      if (req.url !== "/introspect") {
        res.statusCode = 404
        res.end()
        return
      }
      res.setHeader("content-type", "application/json")
      res.end(
        JSON.stringify({
          active: true,
          aud: "aud-introspection",
          exp: Math.floor(Date.now() / 1000) + 120,
        }),
      )
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("failed to start introspection server")
      const introspectionUrl = `http://127.0.0.1:${address.port}/introspect`
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          Env.set("OPENCODE_TOOL_ENDPOINT_API_KEY", "test-token")
          Env.set("OPENCODE_COMPAT_OAUTH_INTROSPECTION_URL", introspectionUrl)
          Env.set("OPENCODE_COMPAT_OAUTH_CLIENT_ID", "client-id")
          Env.set("OPENCODE_COMPAT_OAUTH_CLIENT_SECRET", "client-secret")
          Env.set("OPENCODE_COMPAT_OAUTH_AUDIENCE", "aud-introspection")

          const app = Server.App()
          const response = await app.request("/v1/models", {
            headers: {
              authorization: "Bearer opaque-token",
              "x-opencode-directory": tmp.path,
            },
          })
          expect(response.status).toBe(200)
        },
      })
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  })

  test("openai supports introspection with bearer client-credentials auth method", async () => {
    await using tmp = await project({
      server: {
        compat: {
          openai: {
            enabled: true,
          },
        },
      },
    })
    await Instance.disposeAll()

    const server = createServer((req, res) => {
      if (req.url === "/oauth2/token") {
        res.setHeader("content-type", "application/json")
        res.end(
          JSON.stringify({
            access_token: "introspection-bearer-token",
            token_type: "Bearer",
            expires_in: 120,
          }),
        )
        return
      }
      if (req.url !== "/introspect") {
        res.statusCode = 404
        res.end()
        return
      }
      const auth = req.headers["authorization"]
      if (auth !== "Bearer introspection-bearer-token") {
        res.statusCode = 401
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({ active: false }))
        return
      }
      res.setHeader("content-type", "application/json")
      res.end(
        JSON.stringify({
          active: true,
          iss: "https://issuer.introspection",
          aud: ["aud-introspection"],
          scope: "compat.read",
          exp: Math.floor(Date.now() / 1000) + 120,
        }),
      )
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("failed to start introspection server")
      const base = `http://127.0.0.1:${address.port}`
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          Env.set("OPENCODE_COMPAT_OAUTH_INTROSPECTION_URL", `${base}/introspect`)
          Env.set("OPENCODE_COMPAT_OAUTH_INTROSPECTION_TOKEN_URL", `${base}/oauth2/token`)
          Env.set("OPENCODE_COMPAT_OAUTH_INTROSPECTION_AUTH_METHOD", "bearer_client_credentials")
          Env.set("OPENCODE_COMPAT_OAUTH_CLIENT_ID", "client-id")
          Env.set("OPENCODE_COMPAT_OAUTH_CLIENT_SECRET", "client-secret")
          Env.set("OPENCODE_COMPAT_OAUTH_ISSUER", "https://issuer.introspection")
          Env.set("OPENCODE_COMPAT_OAUTH_AUDIENCE", "aud-introspection")
          Env.set("OPENCODE_COMPAT_OAUTH_REQUIRED_SCOPE", "compat.read")
          Env.set("OPENCODE_TOOL_ENDPOINT_API_KEY", "test-token")
          const app = Server.App()
          const response = await app.request("/v1/models", {
            headers: {
              authorization: "Bearer opaque-token-bearer-auth",
              "x-opencode-directory": tmp.path,
            },
          })
          expect(response.status).toBe(200)
        },
      })
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  })

  test("openai falls back from jwt verification failure to introspection when enabled", async () => {
    await using tmp = await project({
      server: {
        compat: {
          openai: {
            enabled: true,
          },
        },
      },
    })
    await Instance.disposeAll()
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { format: "pem", type: "spki" },
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
    })
    const token = signRS256(
      { exp: Math.floor(Date.now() / 1000) + 120, iss: "https://bad-issuer", aud: "bad-aud" },
      privateKey,
      "kid-missing",
    )
    const server = createServer((req, res) => {
      if (req.url !== "/introspect") {
        res.statusCode = 404
        res.end()
        return
      }
      res.setHeader("content-type", "application/json")
      res.end(
        JSON.stringify({
          active: true,
          iss: "https://fallback-issuer",
          aud: "fallback-aud",
          scope: "compat.read",
          exp: Math.floor(Date.now() / 1000) + 120,
        }),
      )
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("failed to start introspection server")
      const introspectionUrl = `http://127.0.0.1:${address.port}/introspect`
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          Env.set("OPENCODE_COMPAT_OIDC_ISSUER", "https://different-issuer")
          Env.set("OPENCODE_COMPAT_OIDC_AUDIENCE", "different-aud")
          Env.set("OPENCODE_COMPAT_OAUTH_INTROSPECTION_URL", introspectionUrl)
          Env.set("OPENCODE_COMPAT_OAUTH_CLIENT_ID", "client-id")
          Env.set("OPENCODE_COMPAT_OAUTH_CLIENT_SECRET", "client-secret")
          Env.set("OPENCODE_COMPAT_OAUTH_ISSUER", "https://fallback-issuer")
          Env.set("OPENCODE_COMPAT_OAUTH_AUDIENCE", "fallback-aud")
          Env.set("OPENCODE_COMPAT_OAUTH_REQUIRED_SCOPE", "compat.read")
          Env.set("OPENCODE_COMPAT_BEARER_FALLBACK_TO_INTROSPECTION", "true")
          Env.set("OPENCODE_TOOL_ENDPOINT_API_KEY", "test-token")

          const app = Server.App()
          const response = await app.request("/v1/models", {
            headers: {
              authorization: `Bearer ${token}`,
              "x-opencode-directory": tmp.path,
            },
          })
          expect(response.status).toBe(200)
        },
      })
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  })

  test("openai introspection enforces strict audience and issuer checks", async () => {
    await using tmp = await project({
      server: {
        compat: {
          openai: {
            enabled: true,
          },
        },
      },
    })
    await Instance.disposeAll()
    const server = createServer((req, res) => {
      if (req.url !== "/introspect") {
        res.statusCode = 404
        res.end()
        return
      }
      res.setHeader("content-type", "application/json")
      res.end(
        JSON.stringify({
          active: true,
          iss: "https://unexpected-issuer",
          aud: "unexpected-aud",
          scope: "compat.read",
          exp: Math.floor(Date.now() / 1000) + 120,
        }),
      )
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("failed to start introspection server")
      const introspectionUrl = `http://127.0.0.1:${address.port}/introspect`
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          Env.set("OPENCODE_COMPAT_OAUTH_INTROSPECTION_URL", introspectionUrl)
          Env.set("OPENCODE_COMPAT_OAUTH_CLIENT_ID", "client-id")
          Env.set("OPENCODE_COMPAT_OAUTH_CLIENT_SECRET", "client-secret")
          Env.set("OPENCODE_COMPAT_OAUTH_ISSUER", "https://expected-issuer")
          Env.set("OPENCODE_COMPAT_OAUTH_AUDIENCE", "expected-aud")
          Env.set("OPENCODE_TOOL_ENDPOINT_API_KEY", "test-token")

          const app = Server.App()
          const response = await app.request("/v1/models", {
            headers: {
              authorization: "Bearer opaque-token",
              "x-opencode-directory": tmp.path,
            },
          })
          expect(response.status).toBe(401)
        },
      })
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  })

  test("openai returns deterministic 401 when introspection times out", async () => {
    await using tmp = await project({
      server: {
        compat: {
          openai: {
            enabled: true,
          },
        },
      },
    })
    await Instance.disposeAll()
    const server = createServer((req, res) => {
      if (req.url !== "/introspect") {
        res.statusCode = 404
        res.end()
        return
      }
      req.on("data", () => {})
      req.on("end", () => {
        setTimeout(() => {
          res.setHeader("content-type", "application/json")
          res.end(JSON.stringify({ active: true }))
        }, 200)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("failed to start introspection server")
      const introspectionUrl = `http://127.0.0.1:${address.port}/introspect`

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          Env.set("OPENCODE_COMPAT_OAUTH_INTROSPECTION_URL", introspectionUrl)
          Env.set("OPENCODE_COMPAT_OAUTH_CLIENT_ID", "client-id")
          Env.set("OPENCODE_COMPAT_OAUTH_CLIENT_SECRET", "client-secret")
          Env.set("OPENCODE_COMPAT_OAUTH_INTROSPECTION_TIMEOUT_MS", "50")
          Env.set("OPENCODE_TOOL_ENDPOINT_API_KEY", "test-token")

          const app = Server.App()
          const first = await app.request("/v1/models", {
            headers: {
              authorization: "Bearer opaque-timeout-token",
              "x-opencode-directory": tmp.path,
            },
          })
          expect(first.status).toBe(401)

          const second = await app.request("/v1/models", {
            headers: {
              authorization: "Bearer opaque-timeout-token",
              "x-opencode-directory": tmp.path,
            },
          })
          expect(second.status).toBe(401)
        },
      })
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  })

  test("openai uses negative cache for failed introspection responses", async () => {
    await using tmp = await project({
      server: {
        compat: {
          openai: {
            enabled: true,
          },
        },
      },
    })
    await Instance.disposeAll()
    let hits = 0
    const server = createServer((req, res) => {
      if (req.url !== "/introspect") {
        res.statusCode = 404
        res.end()
        return
      }
      hits += 1
      res.statusCode = 500
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ error: "temporary failure" }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("failed to start introspection server")
      const introspectionUrl = `http://127.0.0.1:${address.port}/introspect`

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          Env.set("OPENCODE_COMPAT_OAUTH_INTROSPECTION_URL", introspectionUrl)
          Env.set("OPENCODE_COMPAT_OAUTH_CLIENT_ID", "client-id")
          Env.set("OPENCODE_COMPAT_OAUTH_CLIENT_SECRET", "client-secret")
          Env.set("OPENCODE_TOOL_ENDPOINT_API_KEY", "test-token")

          const app = Server.App()
          const first = await app.request("/v1/models", {
            headers: {
              authorization: "Bearer opaque-cache-token",
              "x-opencode-directory": tmp.path,
            },
          })
          expect(first.status).toBe(401)

          const second = await app.request("/v1/models", {
            headers: {
              authorization: "Bearer opaque-cache-token",
              "x-opencode-directory": tmp.path,
            },
          })
          expect(second.status).toBe(401)
        },
      })
      expect(hits).toBe(1)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  })

  test("openai does not fallback to introspection when fallback flag is disabled", async () => {
    await using tmp = await project({
      server: {
        compat: {
          openai: {
            enabled: true,
          },
        },
      },
    })
    await Instance.disposeAll()
    let hits = 0
    const server = createServer((req, res) => {
      if (req.url !== "/introspect") {
        res.statusCode = 404
        res.end()
        return
      }
      hits += 1
      res.setHeader("content-type", "application/json")
      res.end(
        JSON.stringify({
          active: true,
          iss: "https://fallback-disabled-issuer",
          aud: "fallback-disabled-aud",
          scope: "compat.read",
          exp: Math.floor(Date.now() / 1000) + 120,
        }),
      )
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("failed to start introspection server")
      const introspectionUrl = `http://127.0.0.1:${address.port}/introspect`

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          Env.set("OPENCODE_COMPAT_OIDC_ISSUER", "https://issuer-never-resolves.invalid")
          Env.set("OPENCODE_COMPAT_OIDC_AUDIENCE", "aud-disabled")
          Env.set("OPENCODE_COMPAT_OAUTH_INTROSPECTION_URL", introspectionUrl)
          Env.set("OPENCODE_COMPAT_OAUTH_CLIENT_ID", "client-id")
          Env.set("OPENCODE_COMPAT_OAUTH_CLIENT_SECRET", "client-secret")
          Env.set("OPENCODE_COMPAT_OAUTH_ISSUER", "https://fallback-disabled-issuer")
          Env.set("OPENCODE_COMPAT_OAUTH_AUDIENCE", "fallback-disabled-aud")
          Env.set("OPENCODE_COMPAT_OAUTH_REQUIRED_SCOPE", "compat.read")
          Env.set("OPENCODE_COMPAT_BEARER_FALLBACK_TO_INTROSPECTION", "false")
          Env.set("OPENCODE_TOOL_ENDPOINT_API_KEY", "test-token")

          const app = Server.App()
          const response = await app.request("/v1/models", {
            headers: {
              authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJiYWQifQ.c2ln",
              "x-opencode-directory": tmp.path,
            },
          })
          expect(response.status).toBe(401)
        },
      })
      expect(hits).toBe(0)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  })

  test("openai returns 401 when oidc discovery endpoint is unreachable", async () => {
    await using tmp = await project({
      server: {
        compat: {
          openai: {
            enabled: true,
          },
        },
      },
    })
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Env.set("OPENCODE_COMPAT_OIDC_ISSUER", "http://127.0.0.1:9")
        Env.set("OPENCODE_COMPAT_OIDC_AUDIENCE", "aud")
        Env.set("OPENCODE_TOOL_ENDPOINT_API_KEY", "test-token")

        const app = Server.App()
        const first = await app.request("/v1/models", {
          headers: {
            authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJodHRwOi8vMTI3LjAuMC4xOjkiLCJhdWQiOiJhdWQifQ.c2ln",
            "x-opencode-directory": tmp.path,
          },
        })
        expect(first.status).toBe(401)

        const second = await app.request("/v1/models", {
          headers: {
            authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJodHRwOi8vMTI3LjAuMC4xOjkiLCJhdWQiOiJhdWQifQ.c2ln",
            "x-opencode-directory": tmp.path,
          },
        })
        expect(second.status).toBe(401)
      },
    })
  })

  test("openai rejects oidc discovery when discovery issuer mismatches configured issuer", async () => {
    await using tmp = await project({
      server: {
        compat: {
          openai: {
            enabled: true,
          },
        },
      },
    })
    await Instance.disposeAll()

    let issuer = ""
    const server = createServer((req, res) => {
      if (req.url === "/.well-known/openid-configuration") {
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({ issuer: `${issuer}/other`, jwks_uri: `${issuer}/jwks` }))
        return
      }
      if (req.url === "/jwks") {
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({ keys: [] }))
        return
      }
      res.statusCode = 404
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("failed to start oidc server")
      issuer = `http://127.0.0.1:${address.port}`

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          Env.set("OPENCODE_COMPAT_OIDC_ISSUER", issuer)
          Env.set("OPENCODE_COMPAT_OIDC_AUDIENCE", "aud")
          Env.set("OPENCODE_TOOL_ENDPOINT_API_KEY", "test-token")

          const app = Server.App()
          const response = await app.request("/v1/models", {
            headers: {
              authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJiYWQifQ.c2ln",
              "x-opencode-directory": tmp.path,
            },
          })
          expect(response.status).toBe(401)
        },
      })
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  })

  test("openai rejects non-https non-loopback introspection endpoint", async () => {
    await using tmp = await project({
      server: {
        compat: {
          openai: {
            enabled: true,
          },
        },
      },
    })
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Env.set("OPENCODE_COMPAT_OAUTH_INTROSPECTION_URL", "http://example.com/introspect")
        Env.set("OPENCODE_COMPAT_OAUTH_CLIENT_ID", "client-id")
        Env.set("OPENCODE_COMPAT_OAUTH_CLIENT_SECRET", "client-secret")
        Env.set("OPENCODE_TOOL_ENDPOINT_API_KEY", "test-token")

        const app = Server.App()
        const response = await app.request("/v1/models", {
          headers: {
            authorization: "Bearer opaque-policy-token",
            "x-opencode-directory": tmp.path,
          },
        })
        expect(response.status).toBe(401)
      },
    })
  })

  test("openai model list returns available model ids", async () => {
    await using tmp = await project({
      server: {
        compat: {
          openai: {
            enabled: true,
          },
        },
      },
    })
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Env.set("OPENCODE_TOOL_ENDPOINT_API_KEY", "test-token")
        const app = Server.App()
        const response = await app.request("/v1/models", {
          headers: {
            authorization: "Bearer test-token",
            "x-opencode-directory": tmp.path,
          },
        })
        expect(response.status).toBe(200)
        const body = (await response.json()) as any
        expect(body.object).toBe("list")
        expect(Array.isArray(body.data)).toBe(true)
        expect(body.data.length).toBeGreaterThan(0)
        expect(typeof body.data[0].id).toBe("string")
      },
    })
  })

  test("openai model list rejects x-api-key-only auth", async () => {
    await using tmp = await project({
      server: {
        compat: {
          openai: {
            enabled: true,
          },
        },
      },
    })
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Env.set("OPENCODE_TOOL_ENDPOINT_API_KEY", "test-token")
        const app = Server.App()
        const response = await app.request("/v1/models", {
          headers: {
            "x-api-key": "test-token",
            "x-opencode-directory": tmp.path,
          },
        })
          expect(response.status).toBe(401)
          expect(await response.json()).toEqual({
            error: {
              type: "authentication_error",
              message: "Unauthorized",
              code: "invalid_api_key",
            },
          })
        },
      })
  })

  test("openai model list works without pre-created instance context", async () => {
    await using tmp = await project({
      server: {
        compat: {
          openai: {
            enabled: true,
          },
        },
      },
    })
    await Instance.disposeAll()
    const previous = process.env.OPENCODE_TOOL_ENDPOINT_API_KEY
    try {
      process.env.OPENCODE_TOOL_ENDPOINT_API_KEY = "test-token"
      const app = Server.App()
      const response = await app.request("/v1/models", {
        headers: {
          authorization: "Bearer test-token",
          "x-api-key": "test-token",
          "x-opencode-directory": tmp.path,
        },
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as any
      expect(body.object).toBe("list")
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_TOOL_ENDPOINT_API_KEY
      else process.env.OPENCODE_TOOL_ENDPOINT_API_KEY = previous
    }
  })

  test("openai invalid chat request returns mapped bad request", async () => {
    await using tmp = await project({
      server: {
        compat: {
          openai: { enabled: true },
        },
      },
    })
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Env.set("OPENCODE_TOOL_ENDPOINT_API_KEY", "test-token")
        const app = Server.App()
        const response = await app.request("/v1/chat/completions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer test-token",
            "x-opencode-directory": tmp.path,
          },
          body: JSON.stringify({ model: "x", messages: [] }),
        })
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({
          error: {
            type: "invalid_request_error",
            message: "Invalid request",
            code: "invalid_request",
          },
        })
      },
    })
  })

  test("anthropic requires auth and ignores anthropic-version", async () => {
    await using tmp = await project({
      server: {
        compat: {
          anthropic: {
            enabled: true,
          },
        },
      },
    })
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Env.set("OPENCODE_TOOL_ENDPOINT_API_KEY", "test-token")
        const app = Server.App()
        const unauthorized = await app.request("/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-opencode-directory": tmp.path,
          },
          body: JSON.stringify({}),
        })
        expect(unauthorized.status).toBe(401)
        expect(await unauthorized.json()).toEqual({
          type: "error",
          error: {
            type: "authentication_error",
            message: "Unauthorized",
          },
        })

        const noVersion = await app.request("/v1/messages/count_tokens", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": "test-token",
            "x-opencode-directory": tmp.path,
          },
          body: JSON.stringify({
            model: "opencode/gpt-5-nano",
            messages: [{ role: "user", content: "hello world" }],
          }),
        })
        expect(noVersion.status).toBe(200)
        expect(await noVersion.json()).toEqual({ input_tokens: 2 })

        const withVersion = await app.request("/v1/messages/count_tokens", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": "test-token",
            "anthropic-version": "2099-12-31",
            "x-opencode-directory": tmp.path,
          },
          body: JSON.stringify({
            model: "opencode/gpt-5-nano",
            messages: [{ role: "user", content: "hello world" }],
          }),
        })
        expect(withVersion.status).toBe(200)
        expect(await withVersion.json()).toEqual({ input_tokens: 2 })

        const bearerOnly = await app.request("/v1/messages/count_tokens", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer valid-looking-token",
            "x-opencode-directory": tmp.path,
          },
          body: JSON.stringify({
            model: "opencode/gpt-5-nano",
            messages: [{ role: "user", content: "hello world" }],
          }),
        })
        expect(bearerOnly.status).toBe(401)

        const bothHeaders = await app.request("/v1/messages/count_tokens", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer ignored",
            "x-api-key": "test-token",
            "x-opencode-directory": tmp.path,
          },
          body: JSON.stringify({
            model: "opencode/gpt-5-nano",
            messages: [{ role: "user", content: "hello world" }],
          }),
        })
        expect(bothHeaders.status).toBe(200)
        expect(await bothHeaders.json()).toEqual({ input_tokens: 2 })
      },
    })
  })

  test("anthropic count_tokens returns deterministic token count", async () => {
    await using tmp = await project({
      server: {
        compat: {
          anthropic: {
            enabled: true,
          },
        },
      },
    })
    await Instance.disposeAll()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Env.set("OPENCODE_TOOL_ENDPOINT_API_KEY", "test-token")
        const app = Server.App()
        const response = await app.request("/v1/messages/count_tokens", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": "test-token",
            "anthropic-version": "2023-06-01",
            "x-opencode-directory": tmp.path,
          },
          body: JSON.stringify({
            model: "opencode/gpt-5-nano",
            messages: [
              { role: "user", content: "hello world" },
              { role: "assistant", content: "ok" },
            ],
          }),
        })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ input_tokens: 3 })
      },
    })
  })
})
