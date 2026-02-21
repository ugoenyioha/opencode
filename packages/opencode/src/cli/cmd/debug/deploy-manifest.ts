import { EOL } from "os"
import { Config } from "../../../config/config"
import { cmd } from "../cmd"

/**
 * ManifestNode represents a single node in the typed config tree.
 * Each node describes the type, supported values, and structure of
 * a config field — derived directly from the Zod schema at runtime.
 */
export interface ManifestNode {
  type: string
  required?: boolean
  default?: unknown
  nullable?: boolean
  values?: string[]
  children?: Record<string, ManifestNode>
  items?: ManifestNode
  variants?: ManifestNode[]
  discriminant?: string
  valueType?: ManifestNode
  value?: unknown
}

/**
 * Generic Zod v4 schema walker.
 *
 * Walks a Zod schema object and produces a typed tree describing the
 * config structure and supported values. Works by reading the internal
 * `def` property (Zod v4's schema definition).
 *
 * Handles: object, enum, array, union, discriminatedUnion (via discriminator),
 * literal, record, optional, default, nullable, pipe, and primitives.
 */
export function walkSchema(schema: unknown): ManifestNode {
  const s = schema as any
  const def = s?.def ?? s?._def
  if (!def) return { type: "unknown" }

  const type: string = def.type

  // Unwrap optional — mark as required: false
  if (type === "optional") {
    const inner = walkSchema(def.innerType)
    return { ...inner, required: false }
  }

  // Unwrap default — capture default value
  if (type === "default") {
    const inner = walkSchema(def.innerType)
    let defaultVal: unknown
    try {
      if (typeof def.defaultValue === "function") {
        defaultVal = def.defaultValue()
      } else if (def.defaultValue !== undefined) {
        defaultVal = def.defaultValue
      }
    } catch {
      // ignore
    }
    return {
      ...inner,
      ...(defaultVal !== undefined ? { default: defaultVal } : {}),
    }
  }

  // Object — recurse into shape
  if (type === "object") {
    const children: Record<string, ManifestNode> = {}
    const shape = def.shape ?? {}
    for (const [key, value] of Object.entries(shape)) {
      children[key] = walkSchema(value)
    }
    return { type: "object", children }
  }

  // Enum — extract allowed values
  if (type === "enum") {
    const values: string[] = s.options ?? Object.keys(def.values ?? {})
    return { type: "enum", values }
  }

  // Array — recurse into element type
  if (type === "array") {
    const element = walkSchema(def.element)
    if (element.type === "enum") {
      return { type: "enum[]", values: element.values }
    }
    const node: ManifestNode = { type: `${element.type}[]` }
    if (element.values) node.values = element.values
    if (element.children) node.items = element
    return node
  }

  // Union — check if it's a discriminated union (has discriminator)
  if (type === "union") {
    const options: ManifestNode[] = (def.options ?? []).map((o: unknown) =>
      walkSchema(o),
    )

    // Zod v4: discriminated unions still have type === "union" but set def.discriminator
    if (def.discriminator) {
      return {
        type: "discriminatedUnion",
        discriminant: def.discriminator,
        variants: options,
      }
    }

    // Simple two-variant union (e.g., enum | enum[])
    const types = options.map((o) => o.type)
    if (types.length === 2) {
      const allValues = options.flatMap((o) => o.values ?? [])
      const node: ManifestNode = { type: types.join(" | ") }
      if (allValues.length) node.values = [...new Set(allValues)]
      return node
    }

    return { type: "union", variants: options }
  }

  // Literal — in Zod v4, value is in def.values[0] or schema.value
  if (type === "literal") {
    const value = s.value ?? def.values?.[0]
    return { type: "literal", ...(value !== undefined ? { value } : {}) }
  }

  // Record
  if (type === "record") {
    const valueNode = walkSchema(def.valueType)
    return { type: "record", valueType: valueNode }
  }

  // Primitives
  if (type === "string") return { type: "string" }
  if (type === "number" || type === "int" || type === "float")
    return { type: "number" }
  if (type === "boolean") return { type: "boolean" }

  // Pipe/transform — walk the input side
  if (type === "pipe") return walkSchema(def.in)

  // Nullable
  if (type === "nullable") {
    const inner = walkSchema(def.innerType)
    return { ...inner, nullable: true }
  }

  return { type: `unknown(${type})` }
}

export const DeployManifestCommand = cmd({
  command: "deploy-manifest",
  describe: "emit the server config structure with supported values",
  builder: (yargs) => yargs,
  handler() {
    // Walk Config.Info's server subtree directly from the Zod schema.
    // No bootstrap needed — we're reading the schema definition, not runtime config.
    const info = Config.Info as any
    const serverField = info.def?.shape?.server ?? info.shape?.server
    if (!serverField) {
      process.stderr.write("error: could not locate server schema in Config.Info" + EOL)
      process.exitCode = 1
      return
    }

    const manifest = {
      version: "1.0.0",
      scope: "server",
      schema: walkSchema(serverField),
    }

    process.stdout.write(JSON.stringify(manifest, null, 2) + EOL)
  },
})
