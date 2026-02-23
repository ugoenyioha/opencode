import { describe, expect, test } from "bun:test"
import { validateStartupAuthConfig } from "../../src/server/auth-startup-validation"

function context(config: any) {
  return {
    config: {
      ...config,
      server: {
        ...(config.server ?? {}),
        toolEndpoint: {
          enabled: true,
          auth: "api-key",
          allowedTools: ["hello_world"],
        },
      },
    },
    getEnv: () => undefined,
    getApiKey: () => "test-api-key",
    hasExternalHttpHook: async () => true,
  }
}

describe("plugin authz startup validation", () => {
  test("fails when server a2a plugin config is missing", async () => {
    await expect(
      validateStartupAuthConfig(
        context({
          server: {
            a2a: {
              authz: {
                provider: "plugin",
              },
            },
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "AUTH_CONFIG_MISSING",
      strategy: "plugin",
      key: "server.a2a.authz.plugin",
      reason: "required",
    })
  })

  test("fails when plugin id is missing", async () => {
    await expect(
      validateStartupAuthConfig(
        context({
          server: {
            a2a: {
              authz: {
                provider: "plugin",
                plugin: {
                  policy: {},
                },
              },
            },
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "AUTH_CONFIG_MISSING",
      strategy: "plugin",
      key: "server.a2a.authz.plugin.id",
      reason: "required",
    })
  })

  test("fails when plugin policy is missing", async () => {
    await expect(
      validateStartupAuthConfig(
        context({
          server: {
            a2a: {
              authz: {
                provider: "plugin",
                plugin: {
                  id: "authz-plugin",
                },
              },
            },
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "AUTH_CONFIG_MISSING",
      strategy: "plugin",
      key: "server.a2a.authz.plugin.policy",
      reason: "required",
    })
  })

  test("fails when plugin policy is not an object", async () => {
    await expect(
      validateStartupAuthConfig(
        context({
          server: {
            a2a: {
              authz: {
                provider: "plugin",
                plugin: {
                  id: "authz-plugin",
                  policy: "not-an-object",
                },
              },
            },
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "AUTH_CONFIG_MISSING",
      strategy: "plugin",
      key: "server.a2a.authz.plugin.policy",
      reason: "required",
    })
  })

  test("passes when plugin policy is an object", async () => {
    await expect(
      validateStartupAuthConfig(
        context({
          server: {
            a2a: {
              authz: {
                provider: "plugin",
                plugin: {
                  id: "authz-plugin",
                  policy: { mode: "user_and_workload" },
                },
              },
            },
          },
        }),
      ),
    ).resolves.toBeUndefined()
  })

  test("passes when plugin policy is empty object", async () => {
    await expect(
      validateStartupAuthConfig(
        context({
          agent: {
            "my-agent": {
              a2a: {
                authz: {
                  provider: "plugin",
                  plugin: {
                    id: "agent-authz-plugin",
                    policy: {},
                  },
                },
              },
            },
          },
        }),
      ),
    ).resolves.toBeUndefined()
  })
})
