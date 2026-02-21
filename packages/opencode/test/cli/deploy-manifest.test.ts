import { describe, expect, test } from "bun:test"
import z from "zod"
import { walkSchema } from "../../src/cli/cmd/debug/deploy-manifest"

describe("deploy-manifest.walkSchema", () => {
  test("string primitive", () => {
    expect(walkSchema(z.string())).toEqual({ type: "string" })
  })

  test("number primitive", () => {
    expect(walkSchema(z.number())).toEqual({ type: "number" })
  })

  test("boolean primitive", () => {
    expect(walkSchema(z.boolean())).toEqual({ type: "boolean" })
  })

  test("simple object with string and number fields", () => {
    const schema = z.object({
      name: z.string(),
      port: z.number(),
    })
    const result = walkSchema(schema)
    expect(result.type).toBe("object")
    expect(result.children?.name).toEqual({ type: "string" })
    expect(result.children?.port).toEqual({ type: "number" })
  })

  test("enum schema extracts values", () => {
    const schema = z.enum(["http", "grpc", "websocket"])
    const result = walkSchema(schema)
    expect(result.type).toBe("enum")
    expect(result.values).toEqual(["http", "grpc", "websocket"])
  })

  test("nested object", () => {
    const schema = z.object({
      server: z.object({
        host: z.string(),
        port: z.number(),
      }),
    })
    const result = walkSchema(schema)
    expect(result.type).toBe("object")
    expect(result.children?.server.type).toBe("object")
    expect(result.children?.server.children?.host).toEqual({ type: "string" })
    expect(result.children?.server.children?.port).toEqual({ type: "number" })
  })

  test("optional field marks required: false", () => {
    const schema = z.object({
      name: z.string(),
      label: z.string().optional(),
    })
    const result = walkSchema(schema)
    expect(result.children?.name.required).toBeUndefined()
    expect(result.children?.label.required).toBe(false)
  })

  test("default captures value", () => {
    const schema = z.object({
      enabled: z.boolean().default(true),
    })
    const result = walkSchema(schema)
    expect(result.children?.enabled.type).toBe("boolean")
    expect(result.children?.enabled.default).toBe(true)
  })

  test("default with function value", () => {
    const schema = z.object({
      tags: z.array(z.string()).default(() => ["a", "b"]),
    })
    const result = walkSchema(schema)
    expect(result.children?.tags.default).toEqual(["a", "b"])
  })

  test("nullable wraps inner type", () => {
    const schema = z.string().nullable()
    const result = walkSchema(schema)
    expect(result.type).toBe("string")
    expect(result.nullable).toBe(true)
  })

  test("array of strings", () => {
    const schema = z.array(z.string())
    const result = walkSchema(schema)
    expect(result.type).toBe("string[]")
  })

  test("array of enums produces enum[]", () => {
    const schema = z.array(z.enum(["read", "write", "admin"]))
    const result = walkSchema(schema)
    expect(result.type).toBe("enum[]")
    expect(result.values).toEqual(["read", "write", "admin"])
  })

  test("array of objects includes items", () => {
    const schema = z.array(
      z.object({
        id: z.string(),
        score: z.number(),
      }),
    )
    const result = walkSchema(schema)
    expect(result.type).toBe("object[]")
    expect(result.items?.type).toBe("object")
    expect(result.items?.children?.id).toEqual({ type: "string" })
    expect(result.items?.children?.score).toEqual({ type: "number" })
  })

  test("two-variant union joins types", () => {
    const schema = z.union([z.string(), z.number()])
    const result = walkSchema(schema)
    expect(result.type).toBe("string | number")
  })

  test("two-variant union with enums merges values", () => {
    const schema = z.union([z.enum(["a", "b"]), z.enum(["c", "d"])])
    const result = walkSchema(schema)
    expect(result.type).toBe("enum | enum")
    expect(result.values).toEqual(["a", "b", "c", "d"])
  })

  test("three-variant union returns variants array", () => {
    const schema = z.union([z.string(), z.number(), z.boolean()])
    const result = walkSchema(schema)
    expect(result.type).toBe("union")
    expect(result.variants).toHaveLength(3)
    expect(result.variants?.map((v) => v.type)).toEqual(["string", "number", "boolean"])
  })

  test("discriminated union", () => {
    const schema = z.discriminatedUnion("type", [
      z.object({ type: z.literal("local"), path: z.string() }),
      z.object({ type: z.literal("remote"), url: z.string() }),
    ])
    const result = walkSchema(schema)
    expect(result.type).toBe("discriminatedUnion")
    expect(result.discriminant).toBe("type")
    expect(result.variants).toHaveLength(2)
    expect(result.variants?.[0].children?.type.type).toBe("literal")
    expect(result.variants?.[0].children?.type.value).toBe("local")
    expect(result.variants?.[1].children?.type.type).toBe("literal")
    expect(result.variants?.[1].children?.type.value).toBe("remote")
  })

  test("literal", () => {
    const schema = z.literal("fixed")
    const result = walkSchema(schema)
    expect(result.type).toBe("literal")
    expect(result.value).toBe("fixed")
  })

  test("record with string values", () => {
    const schema = z.record(z.string(), z.string())
    const result = walkSchema(schema)
    expect(result.type).toBe("record")
    expect(result.valueType).toEqual({ type: "string" })
  })

  test("record with complex value type", () => {
    const schema = z.record(
      z.string(),
      z.object({ enabled: z.boolean() }),
    )
    const result = walkSchema(schema)
    expect(result.type).toBe("record")
    expect(result.valueType?.type).toBe("object")
    expect(result.valueType?.children?.enabled).toEqual({ type: "boolean" })
  })

  test("pipe unwraps to input side", () => {
    const schema = z.string().transform((v) => parseInt(v, 10))
    const result = walkSchema(schema)
    expect(result.type).toBe("string")
  })

  test("optional + default combined", () => {
    const schema = z.object({
      port: z.number().optional().default(8080),
    })
    const result = walkSchema(schema)
    expect(result.children?.port.type).toBe("number")
    expect(result.children?.port.default).toBe(8080)
    expect(result.children?.port.required).toBe(false)
  })

  test("unknown input returns unknown type", () => {
    expect(walkSchema(null)).toEqual({ type: "unknown" })
    expect(walkSchema(undefined)).toEqual({ type: "unknown" })
    expect(walkSchema(42)).toEqual({ type: "unknown" })
  })

  test("real Config.Server schema produces valid manifest", async () => {
    const { Config } = await import("../../src/config/config")
    const info = Config.Info as any
    const server = info.def?.shape?.server ?? info.shape?.server
    expect(server).toBeDefined()
    const result = walkSchema(server)
    // Server is wrapped in optional, so the inner type is object
    expect(result.type).toBe("object")
    expect(result.required).toBe(false)
    expect(result.children?.port.type).toBe("number")
    expect(result.children?.a2a).toBeDefined()
    expect(result.children?.toolEndpoint).toBeDefined()
  })
})
