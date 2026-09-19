const PARTIAL_READ_MARKER = "[Partial read:"
const INCOMPLETE_FILE_MARKER = "It is NOT the complete file."

function parseObject(input: unknown): Record<string, unknown> | undefined {
  let value = input
  if (typeof value === "string") {
    try { value = JSON.parse(value) } catch { return undefined }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function stringValue(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    if (typeof record[key] === "string") return record[key] as string
  }
  return undefined
}

export type PartialReadMutationRefusal = {
  reason: string
  filePath?: string
}

/** Refuse only whole-file mutations that echo this provider's partial-read marker. */
export function partialReadMutationRefusal(toolName: string, input: unknown): PartialReadMutationRefusal | undefined {
  const record = parseObject(input)
  if (!record) return undefined

  let content: string | undefined
  if (toolName === "write") {
    content = stringValue(record, ["content", "file_text", "fileText", "data", "text"])
  } else if (toolName === "apply_patch") {
    const patch = stringValue(record, ["patchText", "patch_text", "patch"])
    if (!patch || !/(?:^|\n)\*\*\* Add File:/.test(patch)) return undefined
    content = patch
  } else {
    return undefined
  }

  if (!content?.includes(PARTIAL_READ_MARKER) || !content.includes(INCOMPLETE_FILE_MARKER)) return undefined
  const nextOffset = /Continue with offset=(\d+)/.exec(content)?.[1]
  const longLine = content.includes("Use a byte-preserving read method")
  return {
    filePath: stringValue(record, ["path", "filePath", "file_path", "filename", "target_file", "file"]),
    reason: nextOffset
      ? `Read the file from offset=${nextOffset}, then use a targeted edit or Update File patch.`
      : longLine
        ? "Inspect the full line with a byte-preserving read method, then use a targeted edit or Update File patch."
        : "Read the remaining file ranges, then use a targeted edit or Update File patch.",
  }
}

/** Remove mutation content while retaining metadata, forcing host validation to fail without changing a file. */
export function mutationArgsWithoutContent(input: unknown): Record<string, unknown> {
  const record = parseObject(input) ?? {}
  const out = { ...record }
  for (const key of ["content", "file_text", "fileText", "data", "text", "patchText", "patch_text", "patch"]) delete out[key]
  return out
}
