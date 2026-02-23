import { test, expect, describe } from "bun:test"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import path from "path"
import fs from "fs/promises"

async function writeConfig(dir: string, config: object, name = "opencode.json") {
  await Bun.write(path.join(dir, name), JSON.stringify(config))
}

describe("Config plugin authz schema", () => {
  test("valid plugin config", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await writeConfig(dir, {
          $schema: "https://opencode.ai/config.json",
          server: {
            a2a: {
              authz: {
                provider: "plugin",
                plugin: {
                  id: "test-plugin",
                  policy: {
                    mode: "user_and_workload"
                  }
                }
              }
            }
          }
        })
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await Config.get()
        expect(config.server?.a2a?.authz?.provider).toBe("plugin")
        expect(config.server?.a2a?.authz?.plugin?.id).toBe("test-plugin")
        expect(config.server?.a2a?.authz?.plugin?.policy).toEqual({ mode: "user_and_workload" })
      },
    })
  })

  test("agent override precedence", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await writeConfig(dir, {
          $schema: "https://opencode.ai/config.json",
          server: {
            a2a: {
              authz: {
                provider: "ext_authz",
                extAuthz: {
                  endpoint: "grpc://opa"
                }
              }
            }
          },
          agent: {
            "my-agent": {
              a2a: {
                authz: {
                  provider: "plugin",
                  plugin: {
                    id: "agent-plugin",
                    policy: {
                      mode: "user_only"
                    }
                  }
                }
              }
            }
          }
        })
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const config = await Config.get()
        expect(config.server?.a2a?.authz?.provider).toBe("ext_authz")
        
        const agentConfig = config.agent?.["my-agent"]
        const agentAuthz = agentConfig?.a2a?.authz
        expect(agentAuthz?.provider).toBe("plugin")
        expect(agentAuthz?.plugin?.id).toBe("agent-plugin")
        expect(agentAuthz?.plugin?.policy).toEqual({ mode: "user_only" })
      },
    })
  })

  test("invalid plugin config: missing policy", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await writeConfig(dir, {
          $schema: "https://opencode.ai/config.json",
          server: {
            a2a: {
              authz: {
                provider: "plugin",
                plugin: {
                  id: "test-plugin",
                },
              },
            },
          },
        })
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await expect(Config.get()).rejects.toThrow()
      },
    })
  })

  test("invalid plugin config: policy must be object", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await writeConfig(dir, {
          $schema: "https://opencode.ai/config.json",
          server: {
            a2a: {
              authz: {
                provider: "plugin",
                plugin: {
                  id: "test-plugin",
                  policy: "not-an-object",
                },
              },
            },
          },
        })
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await expect(Config.get()).rejects.toThrow()
      },
    })
  })
})
