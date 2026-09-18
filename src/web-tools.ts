// Host-neutral types: do not value-import `@opencode-ai/plugin` from this
// module. The OpenCode 2.0 entrypoint pulls it in, and 2.0's root export has
// no `tool`. The classic `tool(...)` registration lives in ./web-search-tool.ts.

type ToolContext = {
  ask: (input: {
    permission: string
    patterns: string[]
    always: string[]
    metadata: Record<string, unknown>
  }) => Promise<void>
  abort?: AbortSignal
}

type ToolResult = {
  title?: string
  output: string
  metadata?: Record<string, unknown>
}

const EXA_MCP_URL = "https://mcp.exa.ai/mcp"
const WEB_SEARCH_TIMEOUT_MS = 25_000

export type OpenCodeWebSearchArgs = {
  query: string
  numResults?: number
  livecrawl?: "fallback" | "preferred"
  type?: "auto" | "fast" | "deep"
  contextMaxCharacters?: number
}

const MAX_QUERY_LENGTH = 2_000
const MAX_URL_LENGTH = 8_192

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/** Reject non-http(s) results (`javascript:`, `data:`, relative paths). */
export function normalizeWebSearchUrl(value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_URL_LENGTH) return undefined
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return undefined
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
  if (!url.hostname) return undefined
  return trimmed
}

/**
 * Runtime check for host tool input. Schema types are not enforced once a
 * model or a 2.0 provider calls the search path directly.
 */
export function normalizeOpenCodeWebSearchArgs(input: unknown): OpenCodeWebSearchArgs {
  if (!isRecord(input)) throw new Error("Web search input must be an object")
  if (typeof input.query !== "string") throw new Error("Web search query must be a string")
  const query = input.query.trim()
  if (!query) throw new Error("Web search query is required")
  if (query.length > MAX_QUERY_LENGTH) throw new Error("Web search query is too long")

  const args: OpenCodeWebSearchArgs = { query }
  if (input.numResults !== undefined) {
    if (typeof input.numResults !== "number" || !Number.isInteger(input.numResults) || input.numResults < 1 || input.numResults > 20) {
      throw new Error("Web search numResults must be an integer from 1 to 20")
    }
    args.numResults = input.numResults
  }
  if (input.livecrawl !== undefined) {
    if (input.livecrawl !== "fallback" && input.livecrawl !== "preferred") {
      throw new Error("Web search livecrawl must be fallback or preferred")
    }
    args.livecrawl = input.livecrawl
  }
  if (input.type !== undefined) {
    if (input.type !== "auto" && input.type !== "fast" && input.type !== "deep") {
      throw new Error("Web search type must be auto, fast, or deep")
    }
    args.type = input.type
  }
  if (input.contextMaxCharacters !== undefined) {
    if (typeof input.contextMaxCharacters !== "number" || !Number.isInteger(input.contextMaxCharacters) || input.contextMaxCharacters <= 0) {
      throw new Error("Web search contextMaxCharacters must be a positive integer")
    }
    args.contextMaxCharacters = input.contextMaxCharacters
  }
  return args
}

function exaMcpUrl(): string {
  const apiKey = process.env.EXA_API_KEY
  if (!apiKey) return EXA_MCP_URL
  const url = new URL(EXA_MCP_URL)
  url.searchParams.set("exaApiKey", apiKey)
  return url.href
}

function mcpText(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const result = (value as { result?: unknown }).result
  if (!result || typeof result !== "object") return undefined
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  for (const item of content) {
    if (
      item &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string"
    ) {
      return (item as { text: string }).text
    }
  }
  return undefined
}

export function parseOpenCodeWebSearchResponse(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  try {
    const text = mcpText(JSON.parse(trimmed))
    if (text) return text
  } catch {
    // MCP may respond as an SSE stream instead of one JSON object.
  }
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue
    try {
      const text = mcpText(JSON.parse(line.slice(6)))
      if (text) return text
    } catch {
      // Ignore non-JSON SSE events.
    }
  }
  return undefined
}

/**
 * Raw Exa web-search call: no host tool context, no permission prompt.
 *
 * Split out so both the classic plugin's `custom_websearch` tool and the
 * OpenCode 2.0 plugin's websearch provider share one implementation — 2.0's
 * ToolContext has no `ask`, permissions being handled by the host instead.
 */

export type OpenCode2WebSearchResult = {
  url: string
  title?: string
  content?: string
  time: { published?: number }
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function publishedMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? Math.floor(value * 1000) : Math.floor(value)
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function asWebSearchResult(row: unknown): OpenCode2WebSearchResult | undefined {
  if (!isRecord(row)) return undefined
  const rawUrl =
    typeof row.url === "string" ? row.url
    : typeof row.href === "string" ? row.href
    : undefined
  const url = rawUrl ? normalizeWebSearchUrl(rawUrl) : undefined
  if (!url) return undefined
  const title = typeof row.title === "string" && row.title.trim() ? row.title.trim() : undefined
  const content =
    typeof row.content === "string" ? row.content
    : typeof row.text === "string" ? row.text
    : typeof row.snippet === "string" ? row.snippet
    : undefined
  const published = publishedMs(row.publishedDate ?? row.published ?? row.date)
  return {
    url,
    ...(title ? { title } : {}),
    ...(content ? { content } : {}),
    time: published !== undefined && published >= 0 ? { published } : {},
  }
}

function parseExaTextResults(text: string): OpenCode2WebSearchResult[] {
  return text.split(/\n\n---\n\n/).flatMap((block) => {
    const rawUrl = block.match(/^URL:\s*(.+)$/m)?.[1]?.trim()
    const url = rawUrl ? normalizeWebSearchUrl(rawUrl) : undefined
    if (!url) return []
    const title = block.match(/^Title:\s*(.+)$/m)?.[1]?.trim()
    const publishedText = block.match(/^Published:\s*(.+)$/m)?.[1]?.trim()
    const published = publishedText && publishedText !== "N/A"
      ? publishedMs(publishedText)
      : undefined
    const content = block.match(/^(?:Highlights|Text):\s*\n?([\s\S]*)$/m)?.[1]?.trim()
    return [{
      url,
      ...(title && title !== "N/A" ? { title } : {}),
      ...(content ? { content } : {}),
      time: published === undefined || published < 0 ? {} : { published },
    }]
  })
}

/**
 * Turn an Exa MCP text blob into OpenCode 2.0 `websearch` results
 * (`{ url, title?, content?, time }`). Unknown shapes yield an empty list.
 */
export function parseExaWebSearchResults(raw: unknown): OpenCode2WebSearchResult[] {
  if (typeof raw !== "string") return []
  const text = parseOpenCodeWebSearchResponse(raw) ?? raw.trim()
  if (!text) return []
  const parsed = tryParseJson(text)
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? Array.isArray((parsed as { results?: unknown }).results)
        ? (parsed as { results: unknown[] }).results
        : Array.isArray((parsed as { data?: unknown }).data)
          ? (parsed as { data: unknown[] }).data
          : []
      : []
  if (rows.length > 0) {
    return rows.flatMap((row) => {
      const result = asWebSearchResult(row)
      return result ? [result] : []
    })
  }
  return parseExaTextResults(text)
}

export async function fetchOpenCodeWebSearchText(
  args: unknown,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const normalized = normalizeOpenCodeWebSearchArgs(args)
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener("abort", abort, { once: true })
  const timeout = setTimeout(() => controller.abort(new Error("Web search timed out")), WEB_SEARCH_TIMEOUT_MS)

  try {
    const response = await fetchImpl(exaMcpUrl(), {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "web_search_exa",
          arguments: {
            query: normalized.query,
            type: normalized.type ?? "auto",
            numResults: normalized.numResults ?? 8,
            livecrawl: normalized.livecrawl ?? "fallback",
            contextMaxCharacters: normalized.contextMaxCharacters,
          },
        },
      }),
      signal: controller.signal,
    })
    const raw = await response.text()
    if (!response.ok) throw new Error(`Web search failed (${response.status}): ${raw.slice(0, 500)}`)
    return parseOpenCodeWebSearchResponse(raw) ?? "No search results found. Please try a different query."
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener("abort", abort)
  }
}

export async function executeOpenCodeWebSearch(
  args: unknown,
  context: ToolContext,
  fetchImpl: typeof fetch = fetch,
): Promise<ToolResult> {
  const normalized = normalizeOpenCodeWebSearchArgs(args)
  if (!context || typeof context.ask !== "function") {
    throw new Error("Web search requires a host permission context")
  }
  await context.ask({
    permission: "websearch",
    patterns: [normalized.query],
    always: ["*"],
    metadata: {
      query: normalized.query,
      numResults: normalized.numResults,
      livecrawl: normalized.livecrawl,
      type: normalized.type,
      contextMaxCharacters: normalized.contextMaxCharacters,
      provider: "exa",
    },
  })

  const output = await fetchOpenCodeWebSearchText(normalized, context.abort, fetchImpl)
  return {
    title: `Exa Web Search: ${normalized.query}`,
    output,
    metadata: { provider: "exa" },
  }
}
