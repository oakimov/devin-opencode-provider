import { executeOpenCodeWebSearch } from "./web-tools.js"

type ZodLike = {
  describe: (text: string) => ZodLike
  optional: () => ZodLike
  int: () => ZodLike
  min: (value: number) => ZodLike
  max: (value: number) => ZodLike
  positive: () => ZodLike
}

type ToolSchema = {
  string: () => ZodLike
  number: () => ZodLike
  enum: (values: readonly string[]) => ZodLike
}

type ToolFactory = {
  tool: (input: Record<string, unknown>) => Record<string, unknown>
  schema: ToolSchema
}

function hasFunctions(value: unknown, names: readonly string[]): boolean {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return names.every((name) => typeof record[name] === "function")
}

/** True when `tool.schema` can build the classic web-search args. */
export function isClassicToolSchema(schema: unknown): schema is ToolSchema {
  if (!schema || typeof schema !== "object") return false
  const record = schema as Record<string, unknown>
  if (typeof record.string !== "function" || typeof record.number !== "function" || typeof record.enum !== "function") {
    return false
  }
  try {
    // Check each builder's own chain. Zod strings do not implement `.int()`.
    return hasFunctions(record.string(), ["describe"])
      && hasFunctions(record.number(), ["int", "min", "max", "optional", "positive"])
      && hasFunctions(record.enum(["auto"]), ["optional"])
  } catch {
    return false
  }
}

/**
 * Accept `tool` as a function-with-schema, or a default-export wrapper.
 * Anything else (missing chain methods, a bare object) is not a factory.
 */
export function classicToolFactoryFromModule(module: unknown): ToolFactory | undefined {
  const records: unknown[] = []
  if (module && (typeof module === "object" || typeof module === "function")) records.push(module)
  if (module && typeof module === "object" && "default" in module) {
    const exported = (module as { default?: unknown }).default
    if (exported && (typeof exported === "object" || typeof exported === "function")) records.push(exported)
  }
  for (const record of records) {
    if (!record || (typeof record !== "object" && typeof record !== "function")) continue
    const tool = (record as { tool?: unknown }).tool
    if (typeof tool !== "function") continue
    const schema = (tool as { schema?: unknown }).schema
    if (!isClassicToolSchema(schema)) continue
    return {
      tool: tool as ToolFactory["tool"],
      schema,
    }
  }
  return undefined
}

/** Build the classic OpenCode web-search tool with the host's own Zod helper. */
export function createOpenCodeWebSearchTool(factory: ToolFactory): Record<string, unknown> {
  const schema = factory.schema
  return factory.tool({
    description: "Search the web for current information using OpenCode's web search backend.",
    args: {
      query: schema.string().describe("Web search query"),
      numResults: schema.number().int().min(1).max(20).optional(),
      livecrawl: schema.enum(["fallback", "preferred"]).optional(),
      type: schema.enum(["auto", "fast", "deep"]).optional(),
      contextMaxCharacters: schema.number().int().positive().optional(),
    },
    execute: executeOpenCodeWebSearch,
  })
}

/**
 * Host-neutral JSON-schema fallback when the classic helper is unavailable.
 * OpenCode's legacy schema adapter marks every listed property required, so
 * expose only the genuinely required query rather than turning four optional
 * tuning fields into mandatory inputs.
 */
export const openCodeWebSearchTool = {
  description: "Search the web for current information using OpenCode's web search backend.",
  args: {
    query: { type: "string", description: "Web search query" },
  },
  execute: executeOpenCodeWebSearch,
}

export type { ToolFactory as OpenCodeToolFactory }

export function createOpenCodeWebSearchToolFromPlugin(pluginModule: unknown): Record<string, unknown> {
  const factory = classicToolFactoryFromModule(pluginModule)
  if (!factory) throw new Error("OpenCode plugin module did not provide tool.schema")
  return createOpenCodeWebSearchTool(factory)
}
