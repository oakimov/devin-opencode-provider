import path from "node:path"
import { trace } from "../debug.js"

const OPENCODE2_READ_TRUNCATION = /^\[Output truncated\. Continue reading with offset:\s*(\d+)\]\s*$/

/**
 * Absolute on this host, plus Windows drive and UNC paths. A posix agent must
 * not prefix `C:/…` or `\\server\…` just because `path.isAbsolute` rejects them.
 */
function isAbsoluteToolPath(filePath: string): boolean {
  return path.isAbsolute(filePath)
    || /^[A-Za-z]:[\\/]/.test(filePath)
    || filePath.startsWith("\\\\")
}

/** Windows drive or UNC path that `path.isAbsolute` rejects on this host. */
function isForeignAbsoluteToolPath(filePath: string): boolean {
  return isAbsoluteToolPath(filePath) && !path.isAbsolute(filePath)
}

/** Separator already used by a drive or UNC path. Host paths keep `path.sep`. */
function toolPathSeparator(filePath: string): string {
  if (path.isAbsolute(filePath)) return path.sep
  if (filePath.startsWith("\\\\") || (filePath.includes("\\") && !filePath.includes("/"))) return "\\"
  return "/"
}

/**
 * Join `relative` onto `root`. Node's `path.resolve` treats `C:/…` and
 * `\\server\…` as relative on posix and prefixes the process cwd. Keep those
 * roots intact, including `..`, and still use `path.resolve` for host paths.
 */
function joinToolPath(root: string, relative: string): string {
  if (!isForeignAbsoluteToolPath(root)) return path.resolve(root, relative)
  const sep = toolPathSeparator(root)
  const base = splitForeignAbsolute(root, sep)
  const parts = [...base.segments]
  for (const part of relative.split(/[\\/]+/)) {
    if (!part || part === ".") continue
    if (part === "..") {
      if (parts.length > base.frozen) parts.pop()
      continue
    }
    parts.push(part)
  }
  return parts.length === 0 ? base.prefix : `${base.prefix}${parts.join(sep)}`
}

function splitForeignAbsolute(
  filePath: string,
  sep: string,
): { prefix: string; segments: string[]; frozen: number } {
  if (filePath.startsWith("\\\\")) {
    const segments = filePath.slice(2).split(/[\\/]+/).filter(Boolean)
    return { prefix: "\\\\", segments, frozen: Math.min(2, segments.length) }
  }
  const rest = filePath.slice(2).replace(/^[\\/]+/, "")
  return {
    prefix: `${filePath.slice(0, 2)}${sep}`,
    segments: rest ? rest.split(/[\\/]+/).filter(Boolean) : [],
    frozen: 0,
  }
}

function isRelativePathToken(token: string): boolean {
  if (!token || isAbsoluteToolPath(token)) return false
  // A slash alone does not make arbitrary shell output a path. In particular,
  // compact JSON, quoted strings, package ids, and shell syntax must remain
  // byte-for-byte model-visible rather than being prefixed with the workspace.
  if (/[\0"'`{}\[\]<>|;]/.test(token) || token.startsWith("@")) return false
  if (
    token.startsWith("./")
    || token.startsWith("../")
    || token.startsWith(".\\")
    || token.startsWith("..\\")
  ) return true
  return token.includes("/") || (path.sep === "\\" && token.includes("\\"))
}

function resolveListedEntry(directory: string, entry: string): string {
  if (!entry || isAbsoluteToolPath(entry)) return entry
  if (entry === "~" || entry.startsWith("~/") || entry.startsWith("~\\")) return entry
  const directoryEntry = entry.endsWith("/") || entry.endsWith("\\")
  const resolved = joinToolPath(directory, entry)
  if (!directoryEntry || resolved.endsWith("/") || resolved.endsWith("\\")) return resolved
  return `${resolved}${toolPathSeparator(resolved)}`
}

function resolveToolPath(filePath: string, workspaceRoot: string | undefined): string {
  if (!filePath || isAbsoluteToolPath(filePath)) return filePath
  if (filePath === "~" || filePath.startsWith("~/") || filePath.startsWith("~\\")) return filePath
  if (!workspaceRoot) return filePath
  return joinToolPath(workspaceRoot, filePath)
}

function normalizeToolText(output: string): string {
  return output.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

type OpenCode2DirectoryListing = {
  text: string
}

/**
 * OpenCode 2 directory reads list bare entry names. Join them onto the
 * directory, then onto the workspace root, so the model can copy a real path
 * instead of inventing an absolute prefix.
 */
function parseOpenCode2DirectoryListing(
  output: string,
  workspaceRoot: string | undefined,
): OpenCode2DirectoryListing | undefined {
  const normalized = normalizeToolText(output).replace(/\n+$/, "")
  if (!normalized.startsWith("Read directory ")) return undefined
  const lines = normalized.split("\n")
  const header = /^Read directory (.*), (?:0 entries|entries (\d+)-(\d+))$/.exec((lines[0] ?? "").trim())
  if (!header) {
    trace("groundDirectory: OpenCode 2 directory header did not match — leaving output unchanged")
    return undefined
  }
  const requested = header[1] ?? ""
  if (!isAbsoluteToolPath(requested) && !workspaceRoot) return undefined
  let bodyEnd = lines.length
  let banner: string | undefined
  if (bodyEnd > 1 && OPENCODE2_READ_TRUNCATION.test(lines[bodyEnd - 1] ?? "")) {
    banner = lines[bodyEnd - 1]
    bodyEnd -= 1
  }
  const rawEntries = lines.slice(1, bodyEnd)
  if (header[2] === undefined) {
    if (rawEntries.length !== 0) return undefined
  } else {
    const start = Number(header[2])
    const end = Number(header[3])
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end - start + 1 !== rawEntries.length) {
      return undefined
    }
  }
  const directory = resolveToolPath(requested, workspaceRoot)
  const entries = rawEntries.map((entry) => resolveListedEntry(directory, entry))
  const headerLine = header[2] === undefined
    ? `Read directory ${directory}, 0 entries`
    : `Read directory ${directory}, entries ${header[2]}-${header[3]}`
  return { text: [headerLine, ...entries, ...(banner ? [banner] : [])].join("\n") }
}

/**
 * OpenCode 1 lists a directory as `<path>` / `<type>directory</type>` /
 * `<entries>` and puts bare names in the body. The path tag is already
 * absolute when OpenCode resolved it; names still need joining onto it.
 */
function groundOpenCode1DirectoryListing(
  output: string,
  workspaceRoot: string | undefined,
): string | undefined {
  const normalized = normalizeToolText(output).replace(/\n+$/, "")
  const match = /^<path>([^<\n]*)<\/path>\n<type>directory<\/type>\n<entries>\n([\s\S]*)\n<\/entries>$/.exec(normalized)
  if (!match) {
    if (normalized.includes("<type>directory</type>")) {
      trace("groundDirectory: OpenCode 1 directory skeleton did not match — leaving output unchanged")
    }
    return undefined
  }
  const requested = match[1] ?? ""
  if (!isAbsoluteToolPath(requested) && !workspaceRoot) return undefined
  const directory = resolveToolPath(requested, workspaceRoot)
  const entries = (match[2] ?? "").split("\n").map((entry) => {
    if (!entry.trim() || entry.trimStart().startsWith("(")) return entry
    return resolveListedEntry(directory, entry)
  })
  return [
    `<path>${directory}</path>`,
    "<type>directory</type>",
    "<entries>",
    ...entries,
    "</entries>",
  ].join("\n")
}

function groundDirectoryOutput(output: string, workspaceRoot: string | undefined): string {
  return parseOpenCode2DirectoryListing(output, workspaceRoot)?.text
    ?? groundOpenCode1DirectoryListing(output, workspaceRoot)
    ?? output
}

/**
 * Rewrite OpenCode grep/glob lines that are still project-relative. Absolute
 * paths, indented match previews, and prose stay untouched. Line previews are
 * never dropped: Devin forwards the text, it does not re-encode a files-only list.
 */
function groundSearchOutput(output: string, workspaceRoot: string | undefined): string {
  if (!workspaceRoot) return output
  const normalized = normalizeToolText(output)
  const first = normalized.split("\n", 1)[0] ?? ""
  const searchShaped = /^Found \d+ matches/.test(first)
    || first === "No matches found"
    || first === "No files found"
  if (!searchShaped && !isBarePathList(normalized)) return output
  return normalized.split("\n").map((line) => rewriteSearchPathLine(line, workspaceRoot)).join("\n")
}

function isBarePathList(output: string): boolean {
  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0 || lines.length > 2000) return false
  return lines.every((line) => {
    if (line.startsWith("(")) return true
    if (/\s/.test(line) || line.includes("://")) return false
    return true
  })
}

function rewriteSearchPathLine(line: string, workspaceRoot: string): string {
  if (!line || line.startsWith(" ") || line.startsWith("\t") || line.startsWith("(")) return line
  if (line.startsWith("Found ") || line === "No matches found" || line === "No files found") return line
  const header = /^(.*):$/.exec(line)
  if (header && !header[1]?.includes("://")) {
    return `${resolveToolPath(header[1] ?? "", workspaceRoot)}:`
  }
  if (line.includes("://")) return line
  return resolveToolPath(line, workspaceRoot)
}

/**
 * Shell stdout is mixed prose. Rewrite only tokens that are clearly relative
 * paths, including `file:line` and `file:line:col`. Leave sentences, URLs, and
 * status words alone.
 */
function groundShellPathText(output: string, root: string | undefined): string {
  if (!root || !output) return output
  return normalizeToolText(output).split("\n").map((line) => rewriteShellPathLine(line, root)).join("\n")
}

function inputRecord(input: unknown): Record<string, unknown> | undefined {
  let value = input
  if (typeof value === "string") {
    try { value = JSON.parse(value) } catch { return undefined }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function shellPathRoot(toolInput: unknown, workspaceRoot: string | undefined): string | undefined {
  const record = inputRecord(toolInput)
  const workingDirectory = ["workdir", "working_directory", "workingDirectory", "cwd"]
    .map((key) => record?.[key])
    .find((value): value is string => typeof value === "string" && value.trim().length > 0)
    ?.trim()
  if (!workingDirectory) return workspaceRoot
  if (isAbsoluteToolPath(workingDirectory)) return workingDirectory
  return workspaceRoot ? joinToolPath(workspaceRoot, workingDirectory) : undefined
}

function rewriteShellPathLine(line: string, root: string): string {
  if (!line || line.startsWith(" ") || line.startsWith("\t")) return line
  const trimmed = line.trimEnd()
  if (trimmed.includes("://") || trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return line
  }
  const located = /^(.+?):(\d+)(?::(\d+))?$/.exec(trimmed)
  if (located && located[1] && isRelativePathToken(located[1])) {
    const suffix = located[3] !== undefined ? `:${located[2]}:${located[3]}` : `:${located[2]}`
    return `${resolveToolPath(located[1], root)}${suffix}`
  }
  if (/\s/.test(trimmed)) return line
  const header = /^(.*):$/.exec(trimmed)
  if (header && header[1] && isRelativePathToken(header[1])) {
    return `${resolveToolPath(header[1], root)}:`
  }
  if (isRelativePathToken(trimmed)) return resolveToolPath(trimmed, root)
  return line
}

/** True for the file-read tool only — matched as a whole segment so tools like
 * `thread`, `todoread`, or `spreadsheet` never get their output unwrapped. */
export function isReadToolName(name: string): boolean {
  if (name === "read" || name === "opencode-read") return true
  return /(^|[-_:/])read([-_:/]|$)/i.test(name)
}

function isSearchToolName(name: string): boolean {
  if (name === "grep" || name === "glob") return true
  return /(^|[-_:/])(grep|glob)([-_:/]|$)/i.test(name)
}

function isShellToolName(name: string): boolean {
  if (name === "bash" || name === "shell" || name === "execute") return true
  return /(^|[-_:/])(bash|shell|execute)([-_:/]|$)/i.test(name)
}

/**
 * Ground relative paths in tool text the model will see again next turn.
 * Grep and glob keep every match preview; only path headers and path-list
 * rows are rewritten. Unrelated tools are left byte-for-byte.
 */
export function groundToolResultText(
  toolName: string,
  output: string,
  workspaceRoot: string | undefined,
  toolInput?: unknown,
): string {
  if (!output) return output
  if (isSearchToolName(toolName)) return groundSearchOutput(output, workspaceRoot)
  if (isShellToolName(toolName)) return groundShellPathText(output, shellPathRoot(toolInput, workspaceRoot))
  if (isReadToolName(toolName)) return groundDirectoryOutput(output, workspaceRoot)
  return output
}
