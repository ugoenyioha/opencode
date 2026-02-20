import { describe, expect, test } from "bun:test"
import { evaluateAuthorization } from "../../src/server/auth-policy"
import {
  AuthConfigStartupError,
  type AuthConfigStartupErrorCode,
  validateStartupAuthConfig,
} from "../../src/server/auth-startup-validation"

type KnownToolAuth = "api-key" | "plugin" | "jwt" | "oidc" | "oauth2"
type ToolAuth = KnownToolAuth | KnownToolAuth[] | "unknown" | string[]

function config(auth: ToolAuth) {
  return {
    server: {
      toolEndpoint: {
        enabled: true,
        auth,
        allowedTools: ["hello_world"],
      },
    },
  } as any
}

async function expectStartupError(params: {
  auth: ToolAuth
  env?: Record<string, string>
  apiKey?: string
  hasExternalHttpHook?: boolean
  code: AuthConfigStartupErrorCode
  message: string
}) {
  await expect(
    validateStartupAuthConfig({
      config: config(params.auth),
      getEnv: (key) => params.env?.[key],
      getApiKey: () => params.apiKey,
      hasExternalHttpHook: async () => params.hasExternalHttpHook ?? false,
    }),
  ).rejects.toMatchObject({
    name: "AuthConfigStartupError",
    code: params.code,
    message: params.message,
  })
}

describe("startup auth config validation", () => {
  test("auth array rejects empty strategy list", async () => {
    await expectStartupError({
      auth: [],
      code: "AUTH_CONFIG_MISSING",
      message: "AUTH_CONFIG_MISSING strategy=unknown key=server.toolEndpoint.auth reason=empty_strategy_list",
    })
  })

  test("auth array rejects duplicate strategy entries", async () => {
    await expectStartupError({
      auth: ["api-key", "plugin", "api-key"],
      code: "AUTH_CONFIG_CONFLICT",
      message: "AUTH_CONFIG_CONFLICT strategy=api-key key=server.toolEndpoint.auth reason=duplicate_strategy",
    })
  })

  test("auth array rejects unknown strategy entries (defensive)", async () => {
    await expectStartupError({
      auth: ["api-key", "unknown"],
      code: "AUTH_CONFIG_UNSUPPORTED_REF",
      message: "AUTH_CONFIG_UNSUPPORTED_REF strategy=unknown key=server.toolEndpoint.auth reason=unsupported_strategy_reference",
    })
  })

  test("api-key strategy fails with deterministic missing error", async () => {
    await expectStartupError({
      auth: "api-key",
      code: "AUTH_CONFIG_MISSING",
      message: "AUTH_CONFIG_MISSING strategy=api-key key=env.OPENCODE_TOOL_ENDPOINT_API_KEY reason=required",
    })
  })

  test("jwt strategy rejects conflicting key sources", async () => {
    await expectStartupError({
      auth: "jwt",
      env: {
        OPENCODE_COMPAT_JWT_JWKS_URL: "https://issuer.example/.well-known/jwks.json",
        OPENCODE_COMPAT_JWT_HS256_SECRET: "super-secret-value",
      },
      code: "AUTH_CONFIG_CONFLICT",
      message:
        "AUTH_CONFIG_CONFLICT strategy=jwt key=env.OPENCODE_COMPAT_JWT_JWKS_URL|env.OPENCODE_COMPAT_JWT_HS256_SECRET reason=mutually_exclusive_key_sources",
    })
  })

  test("oidc strategy enforces strict url safety with sanitized detail", async () => {
    await expectStartupError({
      auth: "oidc",
      env: {
        OPENCODE_COMPAT_OIDC_ISSUER: "http://example.internal/auth",
      },
      code: "AUTH_CONFIG_INVALID_URL",
      message:
        "AUTH_CONFIG_INVALID_URL strategy=oidc key=env.OPENCODE_COMPAT_OIDC_ISSUER reason=requires_https_or_exact_loopback_http url_class=scheme=http host_class=non_loopback path_class=custom",
    })
  })

  test("oidc multi issuer rejects malformed JSON", async () => {
    await expectStartupError({
      auth: "oidc",
      env: {
        OPENCODE_COMPAT_OIDC_ISSUERS_JSON: "{bad-json",
      },
      code: "AUTH_CONFIG_UNSUPPORTED_REF",
      message: "AUTH_CONFIG_UNSUPPORTED_REF strategy=oidc key=env.OPENCODE_COMPAT_OIDC_ISSUERS_JSON reason=invalid_json",
    })
  })

  test("oidc multi issuer rejects non-object entries", async () => {
    await expectStartupError({
      auth: "oidc",
      env: {
        OPENCODE_COMPAT_OIDC_ISSUERS_JSON: JSON.stringify(["https://issuer.example"]),
      },
      code: "AUTH_CONFIG_UNSUPPORTED_REF",
      message:
        "AUTH_CONFIG_UNSUPPORTED_REF strategy=oidc key=env.OPENCODE_COMPAT_OIDC_ISSUERS_JSON reason=entry_must_be_object",
    })
  })

  test("oidc multi issuer rejects unknown object keys", async () => {
    await expectStartupError({
      auth: "oidc",
      env: {
        OPENCODE_COMPAT_OIDC_ISSUERS_JSON: JSON.stringify([{ issuer: "https://issuer.example", extra: "nope" }]),
      },
      code: "AUTH_CONFIG_UNSUPPORTED_REF",
      message:
        "AUTH_CONFIG_UNSUPPORTED_REF strategy=oidc key=env.OPENCODE_COMPAT_OIDC_ISSUERS_JSON reason=unknown_entry_keys",
    })
  })

  test("oidc multi issuer rejects duplicate normalized issuers", async () => {
    await expectStartupError({
      auth: "oidc",
      env: {
        OPENCODE_COMPAT_OIDC_ISSUERS_JSON: JSON.stringify([
          { issuer: "https://issuer.example/" },
          { issuer: "https://issuer.example" },
        ]),
      },
      code: "AUTH_CONFIG_CONFLICT",
      message:
        "AUTH_CONFIG_CONFLICT strategy=oidc key=env.OPENCODE_COMPAT_OIDC_ISSUERS_JSON reason=duplicate_normalized_issuers",
    })
  })

  test("oidc startup rejects legacy and multi issuer config conflict", async () => {
    await expectStartupError({
      auth: "oidc",
      env: {
        OPENCODE_COMPAT_OIDC_ISSUER: "https://issuer.example",
        OPENCODE_COMPAT_OIDC_ISSUERS_JSON: JSON.stringify([{ issuer: "https://issuer-2.example" }]),
      },
      code: "AUTH_CONFIG_CONFLICT",
      message:
        "AUTH_CONFIG_CONFLICT strategy=oidc key=env.OPENCODE_COMPAT_OIDC_ISSUER|env.OPENCODE_COMPAT_OIDC_ISSUERS_JSON reason=mutually_exclusive_issuer_sources",
    })
  })

  test("oidc multi issuer validates URL policy with sanitized detail", async () => {
    await expectStartupError({
      auth: "oidc",
      env: {
        OPENCODE_COMPAT_OIDC_ISSUERS_JSON: JSON.stringify([{ issuer: "http://example.internal/auth" }]),
      },
      code: "AUTH_CONFIG_INVALID_URL",
      message:
        "AUTH_CONFIG_INVALID_URL strategy=oidc key=env.OPENCODE_COMPAT_OIDC_ISSUERS_JSON reason=requires_https_or_exact_loopback_http url_class=scheme=http host_class=non_loopback path_class=custom",
    })
  })

  test("oauth2 strategy validates timeout bounds", async () => {
    await expectStartupError({
      auth: "oauth2",
      env: {
        OPENCODE_COMPAT_OAUTH_INTROSPECTION_URL: "https://auth.example.com/introspect",
        OPENCODE_COMPAT_OAUTH_CLIENT_ID: "client-id",
        OPENCODE_COMPAT_OAUTH_CLIENT_SECRET: "client-secret",
        OPENCODE_COMPAT_OAUTH_INTROSPECTION_TIMEOUT_MS: "0",
      },
      code: "AUTH_CONFIG_BOUNDS",
      message:
        "AUTH_CONFIG_BOUNDS strategy=oauth2 key=env.OPENCODE_COMPAT_OAUTH_INTROSPECTION_TIMEOUT_MS reason=must_be_integer_between_1_and_120000",
    })
  })

  test("unsupported strategy ref fails startup", async () => {
    await expectStartupError({
      auth: "unknown",
      code: "AUTH_CONFIG_UNSUPPORTED_REF",
      message: "AUTH_CONFIG_UNSUPPORTED_REF strategy=unknown key=server.toolEndpoint.auth reason=unsupported_strategy_reference",
    })
  })

  test("array prereq checks fail deterministically in declaration order", async () => {
    await expectStartupError({
      auth: ["plugin", "api-key"],
      code: "AUTH_CONFIG_MISSING",
      message: "AUTH_CONFIG_MISSING strategy=plugin key=plugin.http.request reason=external_hook_required",
    })

    await expectStartupError({
      auth: ["api-key", "plugin"],
      code: "AUTH_CONFIG_MISSING",
      message: "AUTH_CONFIG_MISSING strategy=api-key key=env.OPENCODE_TOOL_ENDPOINT_API_KEY reason=required",
    })

    await expectStartupError({
      auth: ["jwt", "api-key"],
      code: "AUTH_CONFIG_MISSING",
      message:
        "AUTH_CONFIG_MISSING strategy=jwt key=env.OPENCODE_COMPAT_JWT_JWKS_URL|env.OPENCODE_COMPAT_JWT_HS256_SECRET reason=requires_one_key_source",
    })
  })

  test("error output is redacted and does not leak secrets or raw endpoints", async () => {
    const secret = "client-secret-never-print"
    const endpoint = "http://example.com/introspect?token=leak-me"
    const promise = validateStartupAuthConfig({
      config: config("oauth2"),
      getEnv: (key) => {
        const env: Record<string, string> = {
          OPENCODE_COMPAT_OAUTH_INTROSPECTION_URL: endpoint,
          OPENCODE_COMPAT_OAUTH_CLIENT_ID: "client-id",
          OPENCODE_COMPAT_OAUTH_CLIENT_SECRET: secret,
        }
        return env[key]
      },
      getApiKey: () => undefined,
      hasExternalHttpHook: async () => false,
    })

    let error: unknown
    try {
      await promise
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(AuthConfigStartupError)
    const message = (error as AuthConfigStartupError).message
    expect(message.includes(secret)).toBe(false)
    expect(message.includes(endpoint)).toBe(false)
    expect(message).toContain("url_class=scheme=http host_class=non_loopback path_class=oauth")
  })

  test("oidc multi issuer error output is redacted and does not leak raw json or full urls", async () => {
    const issuer = "http://example.com/auth?token=leak-me"
    const json = JSON.stringify([{ issuer }])
    const promise = validateStartupAuthConfig({
      config: config("oidc"),
      getEnv: (key) => {
        const env: Record<string, string> = {
          OPENCODE_COMPAT_OIDC_ISSUERS_JSON: json,
        }
        return env[key]
      },
      getApiKey: () => undefined,
      hasExternalHttpHook: async () => false,
    })

    let error: unknown
    try {
      await promise
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(AuthConfigStartupError)
    const message = (error as AuthConfigStartupError).message
    expect(message.includes(issuer)).toBe(false)
    expect(message.includes(json)).toBe(false)
    expect(message).toContain("url_class=scheme=http host_class=non_loopback path_class=custom")
  })

  test("valid startup matrix passes for jwt, oidc, and oauth2", async () => {
    await expect(
      validateStartupAuthConfig({
        config: config("jwt"),
        getEnv: (key) => ({ OPENCODE_COMPAT_JWT_HS256_SECRET: "hs-secret" })[key],
        getApiKey: () => undefined,
        hasExternalHttpHook: async () => false,
      }),
    ).resolves.toBeUndefined()

    await expect(
      validateStartupAuthConfig({
        config: config("oidc"),
        getEnv: (key) => ({ OPENCODE_COMPAT_OIDC_ISSUER: "https://issuer.example" })[key],
        getApiKey: () => undefined,
        hasExternalHttpHook: async () => false,
      }),
    ).resolves.toBeUndefined()

    await expect(
      validateStartupAuthConfig({
        config: config("oidc"),
        getEnv: (key) =>
          ({
            OPENCODE_COMPAT_OIDC_ISSUERS_JSON: JSON.stringify([
              { issuer: "https://issuer-a.example", audience: "aud-a" },
              { issuer: "https://issuer-b.example", audience: ["aud-b", "aud-b-2"] },
            ]),
          })[key],
        getApiKey: () => undefined,
        hasExternalHttpHook: async () => false,
      }),
    ).resolves.toBeUndefined()

    await expect(
      validateStartupAuthConfig({
        config: config("oauth2"),
        getEnv: (key) =>
          ({
            OPENCODE_COMPAT_OAUTH_INTROSPECTION_URL: "http://localhost/introspect",
            OPENCODE_COMPAT_OAUTH_CLIENT_ID: "client-id",
            OPENCODE_COMPAT_OAUTH_CLIENT_SECRET: "client-secret",
            OPENCODE_COMPAT_OAUTH_INTROSPECTION_AUTH_METHOD: "client_secret_post",
          })[key],
        getApiKey: () => undefined,
        hasExternalHttpHook: async () => false,
      }),
    ).resolves.toBeUndefined()

    await expect(
      validateStartupAuthConfig({
        config: config(["api-key", "jwt"]),
        getEnv: (key) => ({ OPENCODE_COMPAT_JWT_HS256_SECRET: "hs-secret" })[key],
        getApiKey: () => "api-key-present",
        hasExternalHttpHook: async () => false,
      }),
    ).resolves.toBeUndefined()
  })
})

describe("runtime auth semantics regression", () => {
  test("plugin strategy remains fail-closed in centralized auth policy", async () => {
    const decision = await evaluateAuthorization("POST", "/tool/hello_world", new Headers(), [
      { method: "POST", path: "/tool/:toolName", auth: "plugin" as any },
    ])
    expect(decision.ok).toBe(false)
    expect(decision.reason).toBe("invalid_token")
    expect(decision.policyMode).toBe("strategies")
  })

  test("api-key strategy remains allow on valid header", async () => {
    const previous = process.env.OPENCODE_TOOL_ENDPOINT_API_KEY
    try {
      process.env.OPENCODE_TOOL_ENDPOINT_API_KEY = "test-api-key"
      const decision = await evaluateAuthorization(
        "POST",
        "/tool/hello_world",
        new Headers({ "x-api-key": "test-api-key" }),
        [{ method: "POST", path: "/tool/:toolName", auth: "api-key" as any }],
      )
      expect(decision.ok).toBe(true)
      expect(decision.strategy).toBe("api-key")
      expect(decision.reason).toBe("none")
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_TOOL_ENDPOINT_API_KEY
      else process.env.OPENCODE_TOOL_ENDPOINT_API_KEY = previous
    }
  })
})
