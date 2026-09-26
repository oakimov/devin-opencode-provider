/**
 * Gemini's Cascade backend rejects JSON Schema type unions such as
 * `["number", "null"]` as an opaque `invalid_argument`. Collapse those
 * unions before tool definitions are encoded. Applies to direct Gemini
 * wire uids and to router-assigned `MODEL_GOOGLE_GEMINI_*` uids.
 */

const JSON_SCHEMA_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array"])

export function isGeminiWireUid(uid: string | undefined): boolean {
  if (!uid) return false
  if (uid.startsWith("MODEL_GOOGLE_GEMINI_")) return true
  return uid.toLowerCase().includes("gemini")
}

export function normalizeToolSchemaForGemini(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => normalizeToolSchemaForGemini(entry))
  if (value === null || typeof value !== "object") return value
  const input = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(input)) {
    if (key === "nullable") continue
    if (key === "type" && Array.isArray(child)) {
      const types = child.filter((entry): entry is string => typeof entry === "string" && entry !== "null" && JSON_SCHEMA_TYPES.has(entry))
      if (types.length >= 1) out.type = types[0]
      continue
    }
    out[key] = child !== null && typeof child === "object" ? normalizeToolSchemaForGemini(child) : child
  }
  return out
}
