import { trace } from "../debug.js"

const OPENCODE2_READ_TRUNCATION = /^\[Output truncated\. Continue reading with offset:\s*(\d+)\]\s*$/
const OPENCODE2_READ_MAX_BYTES = 50 * 1024
const OPENCODE2_READ_MAX_LINES = 2_000
const OPENCODE2_READ_MAX_LINE_CHARS = 2_000
const OPENCODE2_READ_LINE_TRUNCATION = `... (line truncated to ${OPENCODE2_READ_MAX_LINE_CHARS} chars)`
const OPENCODE2_MAX_RENDERED_LINE_BYTES =
  (OPENCODE2_READ_MAX_LINE_CHARS * 3) + Buffer.byteLength(OPENCODE2_READ_LINE_TRUNCATION, "utf8") + 1

type ReadRequestMetadata = {
  offset?: number
  limit?: number
}

type ParsedRead = {
  content: string
  startLine?: number
  endLine?: number
  totalLines?: number
  nextOffset?: number
  hostTruncated: boolean
  outputCapped: boolean
  truncatedLines: number[]
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : undefined
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

function requestMetadata(input: unknown): ReadRequestMetadata {
  let value = input
  if (typeof value === "string") {
    try { value = JSON.parse(value) } catch { return {} }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  const offset = numberValue(record.offset)
  const limit = numberValue(record.limit)
  return {
    ...(offset !== undefined ? { offset } : {}),
    ...(limit !== undefined ? { limit } : {}),
  }
}

function normalizeToolText(output: string): string {
  return output.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

function parseOpenCode2FileRead(output: string, request: ReadRequestMetadata): ParsedRead | undefined {
  const normalized = normalizeToolText(output).replace(/\n+$/, "")
  if (!normalized.startsWith("Read file ")) return undefined
  const lines = normalized.split("\n")
  const headerLine = (lines[0] ?? "").trim()
  const empty = /^Read file (.*), 0 lines$/.exec(headerLine)
  if (empty) {
    if (lines.length !== 1) return undefined
    return {
      content: "",
      totalLines: 0,
      hostTruncated: false,
      outputCapped: false,
      truncatedLines: [],
    }
  }

  const header = /^Read file (.*), lines (\d+)-(\d+)$/.exec(headerLine)
  if (!header) return undefined
  const start = Number(header[2])
  const end = Number(header[3])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return undefined

  let bodyEnd = lines.length
  let nextOffset: number | undefined
  const banner = OPENCODE2_READ_TRUNCATION.exec(lines[lines.length - 1] ?? "")
  if (banner) {
    nextOffset = Number(banner[1])
    if (!Number.isSafeInteger(nextOffset) || nextOffset < 1) return undefined
    bodyEnd -= 1
  }

  const expected = end - start + 1
  if (bodyEnd - 1 !== expected) return undefined
  const raw: string[] = []
  const truncatedLines: number[] = []
  for (let index = 0; index < expected; index++) {
    const match = /^(\d+):[ \t](.*)$/.exec(lines[index + 1] ?? "")
    if (!match || Number(match[1]) !== start + index) return undefined
    const value = match[2] ?? ""
    if (
      value.length === OPENCODE2_READ_MAX_LINE_CHARS + OPENCODE2_READ_LINE_TRUNCATION.length
      && value.endsWith(OPENCODE2_READ_LINE_TRUNCATION)
    ) {
      truncatedLines.push(start + index)
    }
    raw.push(value)
  }

  const content = raw.join("\n")
  const hostTruncated = nextOffset !== undefined
  const effectiveLineLimit = request.limit !== undefined && request.limit > 0
    ? Math.min(request.limit, OPENCODE2_READ_MAX_LINES)
    : OPENCODE2_READ_MAX_LINES
  const outputCapped = hostTruncated
    && expected < effectiveLineLimit
    && Buffer.byteLength(content, "utf8") > OPENCODE2_READ_MAX_BYTES - OPENCODE2_MAX_RENDERED_LINE_BYTES

  return {
    content,
    startLine: start,
    endLine: end,
    ...(hostTruncated ? { nextOffset } : { totalLines: end }),
    hostTruncated,
    outputCapped,
    truncatedLines,
  }
}

function parseOpenCode1Read(output: string): ParsedRead | undefined {
  const contentHeaderIdx = output.indexOf("<content>")
  if (contentHeaderIdx === -1) return undefined
  const header = normalizeToolText(output.slice(0, contentHeaderIdx)).replace(/^\uFEFF/, "")
  if (!/^<path>[\s\S]*<\/path>\s*<type>file<\/type>\s*$/.test(header)) return undefined

  let rest = normalizeToolText(output.slice(contentHeaderIdx + "<content>".length))
  if (rest.startsWith("\n")) rest = rest.slice(1)
  const lines = rest.split("\n")
  const raw: string[] = []
  let index = 0
  for (; index < lines.length; index++) {
    const match = /^(\d+):[ \t]?(.*)$/.exec(lines[index] ?? "")
    if (!match) break
    raw.push(match[2] ?? "")
  }

  const footerLines: string[] = []
  for (; index < lines.length; index++) {
    const line = lines[index] ?? ""
    if (line.trim().startsWith("</content")) break
    if (line.trim()) footerLines.push(line.trim())
  }
  const footer = footerLines.join("\n")
  const emptyEnvelope = (lines[0] ?? "").trim().startsWith("</content")
  const isKnownEnvelope = raw.length > 0
    || emptyEnvelope
    || footer.includes("End of file")
    || footer.includes("Showing lines")
    || footer.includes("Output capped")
  if (!isKnownEnvelope) {
    trace("normalizeReadOutput: OpenCode 1 read skeleton did not match the numbered body parser — leaving output unchanged")
    return undefined
  }

  const showing = /Showing lines\s+(\d+)-(\d+)(?:\s+of\s+(\d+))?[\s\S]*?Use offset=(\d+)/i.exec(footer)
  const complete = /End of file\s*-\s*total\s+(\d+)\s+lines?/i.exec(footer)
  const startLine = showing ? Number(showing[1]) : undefined
  const endLine = showing ? Number(showing[2]) : undefined
  const totalLines = showing?.[3] ? Number(showing[3]) : complete ? Number(complete[1]) : undefined
  const nextOffset = showing ? Number(showing[4]) : undefined
  return {
    content: raw.join("\n"),
    ...(startLine !== undefined ? { startLine } : {}),
    ...(endLine !== undefined ? { endLine } : {}),
    ...(totalLines !== undefined ? { totalLines } : {}),
    ...(nextOffset !== undefined ? { nextOffset } : {}),
    hostTruncated: showing !== null,
    outputCapped: /Output capped at/i.test(footer),
    truncatedLines: [],
  }
}

function partialPageNotice(parsed: ParsedRead, request: ReadRequestMetadata): string | undefined {
  if (!parsed.hostTruncated || parsed.startLine === undefined || parsed.endLine === undefined) return undefined
  const rangeRequested = request.offset !== undefined || request.limit !== undefined
  if (rangeRequested && !parsed.outputCapped) return undefined
  const range = parsed.totalLines !== undefined
    ? `lines ${parsed.startLine}-${parsed.endLine} of ${parsed.totalLines}`
    : `lines ${parsed.startLine}-${parsed.endLine}`
  const nextOffset = parsed.nextOffset ?? parsed.endLine + 1
  return (
    `[Partial read: the content above is ${range}`
    + (parsed.outputCapped ? ", capped at the host's 50 KB output limit" : "")
    + `. It is NOT the complete file. Continue with offset=${nextOffset} before acting on the whole file; `
    + `writing the content above back would delete everything after line ${parsed.endLine}.]`
  )
}

function longLineNotice(parsed: ParsedRead): string | undefined {
  if (parsed.truncatedLines.length === 0) return undefined
  const displayed = parsed.truncatedLines.slice(0, 8).join(", ")
  const remainder = parsed.truncatedLines.length > 8 ? ` and ${parsed.truncatedLines.length - 8} more` : ""
  return (
    `[Partial read: OpenCode shortened ${parsed.truncatedLines.length === 1 ? "line" : "lines"} `
    + `${displayed}${remainder} to ${OPENCODE2_READ_MAX_LINE_CHARS} characters. `
    + "It is NOT the complete file. Use a byte-preserving read method to inspect the full line content before "
    + "acting on the whole file; writing the content above back would lose data.]"
  )
}

/**
 * Convert OpenCode 1.x/2.0 file-read renderings into raw file text. Truncation
 * signals are replaced with a provider marker that cannot be mistaken for file
 * content and can be rejected if a model echoes it into a whole-file write.
 */
export function normalizeOpenCodeReadOutput(output: string, toolInput?: unknown): string {
  if (typeof output !== "string" || output.length === 0) return output
  const request = requestMetadata(toolInput)
  const parsed = parseOpenCode2FileRead(output, request) ?? parseOpenCode1Read(output)
  if (!parsed) {
    if (normalizeToolText(output).startsWith("Read file ")) {
      trace("normalizeReadOutput: OpenCode 2 read header did not match the page parser — leaving output unchanged")
    }
    return output
  }

  const notices = [partialPageNotice(parsed, request), longLineNotice(parsed)].filter((v): v is string => !!v)
  if (notices.length === 0) return parsed.content
  return parsed.content ? `${parsed.content}\n\n${notices.join("\n\n")}` : notices.join("\n\n")
}
