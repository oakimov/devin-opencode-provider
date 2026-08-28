/**
 * Synthesis of OpenCode `apply_patch` envelopes from Devin’s native write/edit tool calls.
 *
 * Mirrors `cursor-opencode-provider/src/protocol/apply-patch.ts` for Devin.
 * See that file for the full upstream rationale (OpenCode 1.x `ToolRegistry.tools`
 * removes `edit`/`write` for `gpt-` models and advertises `apply_patch` instead).
 *
 * This module is host-neutral: it only builds patch text. Whether to apply it
 * is decided by the caller based on the advertised catalog for the current turn.
 */

export const APPLY_PATCH_TOOL = "apply_patch"

const BEGIN = "*** Begin Patch"
const END = "*** End Patch"

export type UpdateChunk = {
  oldLines: string[]
  newLines: string[]
}

export function buildAddFilePatch(filePath: string, content: string): string {
  const lines = splitLines(content)
  return [BEGIN, `*** Add File: ${filePath}`, ...lines.map((line) => `+${line}`), END].join("\n")
}

export function buildUpdateFilePatch(filePath: string, chunks: UpdateChunk[]): string {
  const body: string[] = []
  for (const chunk of chunks) {
    body.push("@@")
    for (const line of chunk.oldLines) body.push(`-${line}`)
    for (const line of chunk.newLines) body.push(`+${line}`)
  }
  return [BEGIN, `*** Update File: ${filePath}`, ...body, END].join("\n")
}

export type SubstringEditPlan =
  | { ok: true; chunks: UpdateChunk[] }
  | { ok: false; reason: string }

export function planSubstringEdit(
  source: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): SubstringEditPlan {
  if (oldString === "") return { ok: false, reason: "the text to replace is empty" }
  const offsets: number[] = []
  for (let at = source.indexOf(oldString); at !== -1; at = source.indexOf(oldString, at + oldString.length)) {
    offsets.push(at)
  }
  if (offsets.length === 0) return { ok: false, reason: "the text to replace was not found in the file" }
  if (offsets.length > 1 && !replaceAll) {
    return { ok: false, reason: `the text to replace appears ${offsets.length} times; it must be unique` }
  }
  const targets = replaceAll ? offsets : offsets.slice(0, 1)
  const chunks: UpdateChunk[] = []
  let previousEnd = -1
  for (const offset of targets) {
    const start = lineStart(source, offset)
    const end = lineEnd(source, offset + oldString.length)
    if (start < previousEnd) {
      return { ok: false, reason: "overlapping replacements cannot be expressed as a patch" }
    }
    previousEnd = end
    const before = source.slice(start, offset)
    const after = source.slice(offset + oldString.length, end)
    chunks.push({
      oldLines: splitLines(source.slice(start, end)),
      newLines: splitLines(before + newString + after),
    })
  }
  return { ok: true, chunks }
}

function splitLines(text: string): string[] {
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text
  return normalized.split("\n")
}

function lineStart(source: string, offset: number): number {
  const at = source.lastIndexOf("\n", offset - 1)
  return at === -1 ? 0 : at + 1
}

function lineEnd(source: string, offset: number): number {
  const at = source.indexOf("\n", offset)
  return at === -1 ? source.length : at
}
