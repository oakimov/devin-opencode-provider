/**
 * Normalize Devin file-tool arguments onto the host schema.
 *
 * OpenCode 1.x (`packages/opencode` read/edit/write) requires `filePath`.
 * OpenCode 2.0 / core tools require `path`. Devin natively emits `filePath`
 * (and sometimes `file_path` / `filename`). A previous normalizer always
 * rewrote to `path` and *deleted* `filePath`, which OpenCode 1.x rejects as
 * `SchemaError(Missing key at ["filePath"])`.
 *
 * Inspect the advertised JSON schema when present; if unknown, keep both keys.
 */

export type HostFilePathKey = "filePath" | "path" | "both"

const FILE_TOOLS = new Set(["read", "edit", "write"])
const PATH_ALIASES = ["path", "filePath", "file_path", "filename", "file", "target_file"] as const

function asJsonSchemaObject(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined
  const s = schema as Record<string, unknown>
  if (s.jsonSchema && typeof s.jsonSchema === "object") return asJsonSchemaObject(s.jsonSchema)
  if (typeof s.properties === "object" || Array.isArray(s.required)) return s
  return undefined
}

export function hostFilePathKey(schema: unknown): HostFilePathKey {
  const obj = asJsonSchemaObject(schema)
  if (!obj) return "both"
  const props = (obj.properties && typeof obj.properties === "object" ? obj.properties : {}) as Record<string, unknown>
  const required = Array.isArray(obj.required) ? obj.required.filter((x): x is string => typeof x === "string") : []
  const has = (k: string) => k in props || required.includes(k)
  const hasFilePath = has("filePath")
  const hasPath = has("path")
  if (hasFilePath && !hasPath) return "filePath"
  if (hasPath && !hasFilePath) return "path"
  return "both"
}

export function fileArgPhrase(schema: unknown): string {
  const k = hostFilePathKey(schema)
  if (k === "path") return "`path`"
  if (k === "filePath") return "`filePath`"
  return "`path` or `filePath`"
}

function pickString(obj: Record<string, unknown>, keys: readonly string[], allowEmpty = false): string | undefined {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v !== "string") continue
    if (v || allowEmpty) return v
  }
  return undefined
}

function applyPathKey(out: Record<string, unknown>, value: string, mode: HostFilePathKey): void {
  for (const alias of PATH_ALIASES) delete out[alias]
  if (mode === "filePath") {
    out.filePath = value
  } else if (mode === "path") {
    out.path = value
  } else {
    out.path = value
    out.filePath = value
  }
}

export function normalizeFileToolArgs(toolName: string, parsed: unknown, schema?: unknown): unknown {
  if (!FILE_TOOLS.has(toolName)) return parsed
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed
  const obj = parsed as Record<string, unknown>
  const out: Record<string, unknown> = { ...obj }

  const p = pickString(obj, PATH_ALIASES)
  if (p) applyPathKey(out, p, hostFilePathKey(schema))

  if (toolName === "edit") {
    const oldS = pickString(obj, ["oldString", "old_string", "oldText", "old_text"], true)
    if (oldS !== undefined) {
      out.oldString = oldS
      delete out.old_string
      delete out.oldText
      delete out.old_text
    }
    const newFromNamed = pickString(obj, ["newString", "new_string", "newText", "new_text"], true)
    const newFromContent = typeof obj.content === "string" ? obj.content : undefined
    const newS = newFromNamed ?? newFromContent
    if (newS !== undefined) {
      out.newString = newS
      delete out.new_string
      delete out.newText
      delete out.new_text
      if (newFromNamed === undefined) delete out.content
    }
    const ra = obj.replaceAll ?? obj.replace_all
    if (typeof ra === "boolean") {
      out.replaceAll = ra
      delete out.replace_all
    }
  }

  if (toolName === "write") {
    const c = pickString(obj, ["content", "file_text", "fileText", "data", "text"], true)
    if (c !== undefined) {
      out.content = c
      delete out.file_text
      delete out.fileText
      delete out.data
      if (!("content" in obj) && "text" in obj) delete out.text
    }
  }

  if (toolName === "read") {
    for (const k of ["limit", "offset"] as const) {
      const v = out[k]
      if (typeof v === "string" && /^\d+$/.test(v)) out[k] = Number(v)
    }
  }

  return out
}
