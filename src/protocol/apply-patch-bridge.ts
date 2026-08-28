/**
 * Bridge Devin tool calls to OpenCode's `apply_patch` when the host swaps
 * the edit-tool family for GPT models.
 *
 * OpenCode 1.x: `ToolRegistry.tools` removes `edit`/`write` and advertises
 * `apply_patch` instead when `modelID.includes("gpt-") && !includes("oss") && !includes("gpt-4")`.
 * See `cursor-opencode-provider/src/protocol/apply-patch.ts` for full rationale.
 * Devin keeps sending `edit`/`write`-style tool calls regardless, so without
 * translation every file mutation on a `gpt-5*` model is refused.
 *
 * This bridge is inert whenever `edit`/`write` are offered normally, or when
 * the host offers neither `edit`/`write` nor `apply_patch`. It is keyed purely
 * off the advertised catalog, not the model id — so it never fires on
 * OpenCode 2.0 where all three are registered.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { APPLY_PATCH_TOOL, buildAddFilePatch, buildUpdateFilePatch, planSubstringEdit } from "./apply-patch.js"
import { trace } from "../debug.js"

const MAX_EDIT_SOURCE_BYTES = 50 * 1024 * 1024

export type RemapResult =
  | { type: "patched"; patchText: string; originalTool: string; filePath: string }
  | { type: "refused"; reason: string; originalTool: string }
  | { type: "passthrough" }

/**
 * Remap a single Devin tool call to `apply_patch` when the catalog requires it.
 *
 * `toolName`/`input` are the raw Devin tool values already forwarded to OpenCode
 * (e.g. `write` with `{ path, content }` or `edit` with `{ filePath, oldText, newText }`).
 * Variations in arg key names across models are handled.
 */
export function remapDevinEditForApplyPatchCatalog(opts: {
  toolName: string
  input: unknown
  advertisedToolNames: ReadonlySet<string> | string[]
  workspaceRoot: string
}): RemapResult {
  const advertised = opts.advertisedToolNames instanceof Set ? opts.advertisedToolNames : new Set(opts.advertisedToolNames)
  const name = opts.toolName
  if (name !== "write" && name !== "edit") return { type: "passthrough" }
  if (advertised.has(name) || !advertised.has(APPLY_PATCH_TOOL)) return { type: "passthrough" }

  const input = opts.input as Record<string, unknown> | string
  const obj: Record<string, unknown> = typeof input === "string"
    ? (() => { try { return JSON.parse(input) as Record<string, unknown> } catch { return {} } })()
    : (input && typeof input === "object" ? input as Record<string, unknown> : {})

  const filePath = stringVal(obj.filePath ?? obj.path ?? obj.file_path ?? obj.filename)
  if (!filePath) {
    return { type: "refused", reason: "no target path was provided", originalTool: name }
  }

  if (name === "write") {
    const content = stringVal(obj.content ?? obj.file_text ?? obj.text ?? obj.fileText ?? obj.data)
    if (content === undefined) {
      return { type: "refused", reason: "no file content was provided", originalTool: name }
    }
    return { type: "patched", patchText: buildAddFilePatch(filePath, content), originalTool: name, filePath }
  }

  const oldText = stringVal(obj.oldString ?? obj.old_string ?? obj.oldText ?? obj.old_text)
  const newText = stringVal(obj.newString ?? obj.new_string ?? obj.newText ?? obj.new_text ?? obj.content)
  if (oldText === undefined || newText === undefined) {
    return { type: "refused", reason: "the replacement is missing its old or new text", originalTool: name }
  }
  const replaceAll = obj.replaceAll === true || obj.replace_all === true
  const absolute = path.resolve(opts.workspaceRoot, filePath)
  let source: string
  try {
    const size = fs.statSync(absolute).size
    if (size > MAX_EDIT_SOURCE_BYTES) {
      return { type: "refused", reason: `the target file is ${Math.round(size / 1024 / 1024)} MB, too large to patch`, originalTool: name }
    }
    source = fs.readFileSync(absolute, "utf8")
  } catch (e) {
    trace(`apply_patch remap: cannot read ${filePath}: ${(e as Error).message}`)
    return { type: "refused", reason: `the target file could not be read (${(e as Error).message})`, originalTool: name }
  }
  const plan = planSubstringEdit(source, oldText, newText, replaceAll)
  if (!plan.ok) {
    return { type: "refused", reason: plan.reason, originalTool: name }
  }
  return { type: "patched", patchText: buildUpdateFilePatch(filePath, plan.chunks), originalTool: name, filePath }
}

function stringVal(v: unknown): string | undefined {
  if (typeof v === "string") return v
  if (v === null || v === undefined) return undefined
  return undefined
}
