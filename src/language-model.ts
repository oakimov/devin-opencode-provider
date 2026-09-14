import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamResult, LanguageModelV3GenerateResult, LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider"
import * as crypto from "node:crypto"
import type { CreateDevinOptions } from "./index.js"
import { getCachedUserJwt, resolveBearerToken } from "./auth.js"
import { devinApiBaseURL } from "./plugin-core.js"
import { trace } from "./debug.js"
import type { ChatHistoryItem, ContentPart, ToolDef } from "./protocol/chat.js"
import { streamChatEvents } from "./protocol/chat.js"
import { buildLanguageModelV3UsageFromCounters, emptyLanguageModelV3Usage, type DevinUsageCounters } from "./usage.js"
import { remapDevinEditForApplyPatchCatalog } from "./protocol/apply-patch-bridge.js"
import { fileArgPhrase, normalizeFileToolArgs } from "./protocol/file-tool-args.js"
import { extractDevinVariantParameters, resolveDevinWireModelId } from "./models.js"
import {
  resolveDevinModelSupportsDocuments,
  resolveDevinModelSupportsImages,
  resolveDevinModelSupportsVideo,
} from "./model-metadata.js"
import {
  assertDevinUserAttachmentSupport,
  attachmentToContentPart,
  extractDevinPromptAttachments,
  hasDevinUserFileAttachments,
} from "./image-input.js"

/** OpenCode session id header, if present — used for cascade/prompt_cache_key affinity. */
export function opencodeSessionKey(callOptions: LanguageModelV3CallOptions): string | undefined {
  const h = callOptions.headers ?? {}
  const raw =
    h["x-session-id"] ??
    h["X-Session-Id"] ??
    h["x-session-affinity"] ??
    h["x-opencode-session"]
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim()
  return undefined
}

function extractSystemPrompt(prompt: LanguageModelV3CallOptions["prompt"]): string | undefined {
  const sys = prompt.filter(m => m.role === "system").map(m => {
    const c = (m as any).content
    if (typeof c === "string") return c
    if (Array.isArray(c)) return c.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n")
    return ""
  }).join("\n\n")
  return sys || undefined
}

/** Exported for issue #1 round-trip tests (AI SDK v3 tool-call shapes). */
export function extractHistory(prompt: LanguageModelV3CallOptions["prompt"]): ChatHistoryItem[] {
  const out: ChatHistoryItem[] = []
  for (const m of prompt) {
    if (m.role === "system") continue
    if (m.role === "user") {
      const c = (m as any).content
      let content: string | ContentPart[] = ""
      if (typeof c === "string") content = c
      else if (Array.isArray(c)) {
        // File parts are resolved asynchronously in doStreamImpl (attachments).
        // Keep text/image here; placeholders for unresolved files are replaced later.
        content = c
          .map((p: any): ContentPart | null => {
            if (p.type === "text") return { type: "text", text: p.text }
            if (p.type === "image") {
              return {
                type: "image",
                mimeType: p.mediaType ?? "image/png",
                base64Data: typeof p.image === "string" ? p.image : "",
              }
            }
            if (p.type === "file") return null
            return { type: "text", text: String(p.text ?? "") }
          })
          .filter((p: ContentPart | null): p is ContentPart => p !== null)
      } else content = String(c ?? "")
      out.push({ role: "user", content })
    } else if (m.role === "assistant") {
      const c = (m as any).content
      let text = ""
      let thinking = ""
      const inlineToolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }> = []
      if (typeof c === "string") text = c
      else if (Array.isArray(c)) {
        const texts: string[] = []
        const thoughts: string[] = []
        for (const p of c as any[]) {
          if (p.type === "text") texts.push(p.text)
          else if (p.type === "reasoning" || p.type === "thinking") {
            const t = typeof p.text === "string" ? p.text : typeof p.thinking === "string" ? p.thinking : ""
            if (t) thoughts.push(t)
          } else if (p.type === "tool-call") {
            // AI SDK v3 / OpenCode shape: tool calls live inside
            // assistant.content[] (issue #1). The legacy m.toolCalls shape
            // below is kept for back-compat.
            if (typeof p.toolCallId === "string" && typeof p.toolName === "string") {
              inlineToolCalls.push({ toolCallId: p.toolCallId, toolName: p.toolName, input: (p as any).input ?? (p as any).args ?? {} })
            }
          }
        }
        text = texts.join("\n")
        thinking = thoughts.join("\n")
      }
      const legacyToolCalls = (m as any).toolCalls as Array<{ toolCallId: string; toolName: string; input: unknown }> | undefined
      const merged = [...(legacyToolCalls ?? []), ...inlineToolCalls]
      const item: ChatHistoryItem = {
        role: "assistant",
        content: text,
        tool_calls: merged.length ? merged.map(tc => ({ id: tc.toolCallId, name: tc.toolName, arguments: typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input ?? {}) })) : undefined,
      }
      if (thinking) item.thinking = thinking
      out.push(item)
    } else if ((m as any).role === "tool") {
      const raw = m as unknown as { role: "tool"; toolCallId?: string; toolName?: string; name?: string; result?: unknown; content?: unknown; output?: unknown }
      // AI SDK v3 / OpenCode shape: tool results live inside tool.content[]
      // as { type: "tool-result", toolCallId, output } (issue #1). The legacy
      // flat { toolCallId, result/content/output } shape is kept for back-compat.
      let toolCallId = raw.toolCallId
      let result: unknown = (raw as any).result ?? (raw as any).output
      const c = (raw as any).content
      if (Array.isArray(c)) {
        const part = (c as any[]).find(p => p && typeof p === "object" && (p as any).type === "tool-result") as any
        if (part) {
          if (!toolCallId && typeof part.toolCallId === "string") toolCallId = part.toolCallId
          result = part.output ?? part.result ?? part.value ?? result
        } else if ((raw as any).result === undefined && (raw as any).output === undefined) {
          result = c
        }
      } else if (c !== undefined && (raw as any).result === undefined && (raw as any).output === undefined) {
        result = c
      }
      const text = toolResultToText({ toolName: raw.toolName ?? raw.name, result: result ?? raw })
      out.push({ role: "tool", content: text, tool_call_id: toolCallId })
    }
  }
  return out
}

function injectAttachmentsOntoLastUser(
  messages: ChatHistoryItem[],
  attachments: ReturnType<typeof attachmentToContentPart>[],
): ChatHistoryItem[] {
  if (!attachments.length) return messages
  const out = messages.map((m) => ({ ...m }))
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role !== "user") continue
    const existing = out[i].content
    const parts: ContentPart[] = typeof existing === "string"
      ? (existing ? [{ type: "text", text: existing }] : [])
      : Array.isArray(existing) ? [...existing] : []
    for (const att of attachments) parts.push(att as ContentPart)
    out[i] = { ...out[i], content: parts }
    break
  }
  return out
}

function extractTools(callOptions: LanguageModelV3CallOptions): ToolDef[] {
  const tools = (callOptions as any).tools as Array<{ name: string; description?: string; inputSchema?: unknown }> | undefined
  if (!Array.isArray(tools)) return []
  return tools.map(t => {
    let description = t.description ?? ""
    // Inject tightened descriptions for the file tools Devin most often misuses.
    // System guidance alone is frequently ignored; the tool's own description is
    // the first thing the model sees when choosing args, so make the contract
    // explicit here as well.
    const schema = (t as any).inputSchema ?? (t as any).parameters ?? { type: "object", properties: {} }
    const pathArg = fileArgPhrase(schema)
    if (t.name === "read") {
      description =
        `Read a text file, image, or directory. Args: ${pathArg} — absolute or relative to workspace root, optional \`offset\` (1-based line/entry) and \`limit\`. Returns raw file text (no \`1: \` line-number prefixes, no XML wrapper — those are stripped before you see it). If result ends with \`(Output capped at 50 KB\` or \`Use offset=\` the file was truncated: you MUST re-read remaining ranges with \`offset\`/\`limit\` before editing or rewriting. Always \`read\` a file before \`edit\`.`
    } else if (t.name === "edit") {
      description =
        `Surgically replace exact text in an EXISTING file. Args: ${pathArg}, \`oldString\` (exact byte-for-byte match including whitespace/indentation/line breaks, must be unique in file), \`newString\` (must differ from oldString), optional \`replaceAll\` (boolean, default false). Include 2–3 lines of exact surrounding context in \`oldString\` so the match is unambiguous. If tool returns \`oldString not found\` or \`multiple matches\`, re-\`read\` the file and copy a larger exact surrounding block verbatim. Never include line-number prefixes like \`1: \` — they are not in the file. Never use \`edit\` to create a new file; use \`write\`. Always \`read\` first.`
    } else if (t.name === "write") {
      description =
        `Create a new file or intentionally overwrite an entire existing file. Args: ${pathArg}, \`content\` (complete file text, all lines). This overwrites — prefer \`edit\` for small targeted patches. Never pass a truncated/capped \`read\` result as \`content\`; re-\`read\` all ranges first. Ensure parent directory exists. Do not use shell/Python/heredocs for file writes while this tool is available.`
    }
    return {
      name: t.name,
      description,
      parameters: schema,
    }
  })
}

// Opencode's `read` tool wraps file content in XML and caps at 50 KB.
// It emits numbered lines inside <content>:
//   <path>/foo</path><type>file</type><content>\n1: line1\n2: line2\n\n(Output capped at 50 KB...)\n</content>
// Strip the envelope and the "N: " prefixes so Devin sees raw file content,
// but preserve the truncation footer so the guidance warning remains visible.
// Mirrors cursor's unwrapReadOutput (src/protocol/tools.ts:1641) — critical for
// not teaching Devin that a capped read is the complete file (cursor bug at 1824).
function unwrapOpencodeReadOutput(text: string): string {
  if (typeof text !== "string" || text.length === 0) return text
  const contentHeaderIdx = text.indexOf("<content>")
  if (contentHeaderIdx === -1) return text
  const header = text.slice(0, contentHeaderIdx)
  const hasSkeleton = header.includes("<path>") && header.includes("<type>file</type>")
  if (!hasSkeleton) {
    trace("unwrapReadOutput: <content> present without <path>/<type>file> skeleton — leaving unchanged (possible format drift)")
    return text
  }
  let rest = text.slice(contentHeaderIdx + "<content>".length)
  if (rest.startsWith("\n")) rest = rest.slice(1)
  const raw: string[] = []
  for (const line of rest.split("\n")) {
    const m = /^(\d+):[ \t]?(.*)$/.exec(line)
    if (!m) break // blank / "(Output capped..." / "</content>" → end of body run
    raw.push(m[2])
  }
  // Envelope confirmed but no numbered body → empty file
  if (raw.length === 0 && rest.startsWith("</content>")) return ""
  // If we didn't consume any numbered lines, fall back to simple extraction (handles
  // future opencode format without line numbers) but strip wrapper tags.
  if (raw.length === 0) {
    const mm = text.match(/<content>([\s\S]*?)<\/content>/)
    if (mm) {
      const inner = mm[1].trim()
      const after = text.slice(text.indexOf("</content>") + "</content>".length).trim()
      // Only preserve genuine truncation footer, not stray XML like </read>
      if (after && after.includes("Output capped")) return inner + "\n\n" + after.replace(/<\/read>.*$/s, "").trim()
      return inner
    }
    return text
  }
  // Check for truncation footer after the numbered block — it appears as a blank line + "(Output capped..."
  // Our loop stopped at the blank line; look ahead for footer text.
  const lines = rest.split("\n")
  let footer = ""
  for (let i = raw.length + 1; i < lines.length; i++) {
    const l = lines[i].trim()
    if (l.startsWith("(Output capped") || l.startsWith("Use offset=")) {
      footer = lines.slice(i).join("\n").replace(/<\/content>.*$/s, "").replace(/<\/read>.*$/s, "").trim()
      break
    }
    if (l.startsWith("</content")) break
  }
  const content = raw.join("\n")
  return footer ? `${content}\n\n${footer}` : content
}

function toolResultToText(m: unknown): string {
  const tr = m as Record<string, unknown>
  const raw = (tr as any).result ?? (tr as any).content ?? tr
  if (typeof raw === "string") {
    // Unwrap read envelope when this tool result came from `read`
    const name = typeof (tr as any).toolName === "string" ? ((tr as any).toolName as string) : typeof (tr as any).name === "string" ? ((tr as any).name as string) : ""
    if (name === "read" || name === "opencode-read" || name.includes("read")) {
      return unwrapOpencodeReadOutput(raw)
    }
    return raw
  }
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>
    if (o.type === "text" || o.type === "error-text") return String(o.value ?? "")
    if (o.type === "json" || o.type === "error-json") return JSON.stringify(o.value ?? null)
    if (o.type === "content" && Array.isArray(o.value)) {
      return (o.value as Array<Record<string, unknown>>).map(c => c.type === "text" ? String(c.text ?? "") : "").join("")
    }
  }
  try { return JSON.stringify(raw ?? "") } catch { return String(raw ?? "") }
}

export function buildDevinOpenCodeGuidance(tools: ToolDef[], workspaceRoot: string): string | undefined {
  if (tools.length === 0) return undefined
  const names = new Set(tools.map(t => t.name))
  const schemaOf = (name: string) => tools.find(t => t.name === name)?.parameters
  const instructions: string[] = []

  // Tight file-tool guidance — Devin frequently fails edits when oldString is
  // hallucinated, truncated, or missing surrounding context, and when capped
  // reads are treated as complete files. Be explicit about exact matching.
  // Arg names follow the advertised host schema (`filePath` on OpenCode 1.x,
  // `path` on OpenCode 2.0); when unknown, tell the model either is accepted.
  if (names.has("read")) {
    const pathArg = fileArgPhrase(schemaOf("read"))
    instructions.push(
      `- \`read\` — Takes ${pathArg} (absolute or relative to workspace root) and optional \`offset\`/\`limit\`. Returns raw file text (line-number prefixes and \`<path>/<content>\` wrapper are already stripped — do not copy \`1: \` prefixes into edits). If the result ends with \`(Output capped at 50 KB\` or \`Use offset=\` / \`requires another offset\`, the file was truncated: you MUST re-\`read\` the remaining ranges with \`offset\` before using the content. Never pass a capped/partial read as whole-file content to \`write\`. Always \`read\` a file before \`edit\`.`,
    )
  }
  if (names.has("edit")) {
    const pathArg = fileArgPhrase(schemaOf("edit"))
    instructions.push(
      `- \`edit\` — For surgical changes to EXISTING files only. Args: ${pathArg}, \`oldString\`, \`newString\`, optional \`replaceAll\` (boolean). \`oldString\` MUST match the file byte-for-byte — exact whitespace, indentation, and line breaks — and MUST be unique in the file. Include 2–3 lines of exact surrounding context before and after the target so the match is unambiguous. If the tool returns \`oldString not found\` or \`multiple matches\`, re-\`read\` the file, copy a larger exact surrounding block (verbatim, including indentation), and retry; use \`replaceAll:true\` only to intentionally change every occurrence. Never include line-number prefixes (e.g. \`1: \`) in \`oldString\`/\`newString\` — they are not in the file. \`oldString\` and \`newString\` must differ. To create a new file, use \`write\`, not \`edit\`.`,
    )
  }
  if (names.has("write")) {
    const pathArg = fileArgPhrase(schemaOf("write"))
    instructions.push(
      names.has("edit")
        ? `- \`write\` — For CREATING new files or intentionally REPLACING an entire file. Args: ${pathArg}, \`content\` (complete file text, all lines). This overwrites the file — prefer \`edit\` for small targeted patches. Never pass a truncated or capped \`read\` result as \`content\`; re-\`read\` all ranges first. Ensure the parent directory exists (create it via \`bash mkdir -p\` if needed). Do not use shell, Python, or heredocs to change file content while \`edit\`/\`write\` are available.`
        : `- \`write\` — Args: ${pathArg}, \`content\` (complete file text). This overwrites. Never pass a truncated \`read\` as \`content\`; re-\`read\` all ranges first. Do not use shell, Python, or heredocs to change file content while \`write\` is available.`,
    )
  } else if (names.has("apply_patch")) {
    instructions.push(
      "- Use OpenCode `apply_patch` for file-content changes; do not use shell, Python, or heredocs to change file content while it is available. Devin-native `write` and `edit` requests are accepted and converted to `apply_patch` automatically, with the same exact-match rules above.",
    )
  }
  // apply_patch alongside edit/write can still happen (e.g. GPT catalog) — remind about capping even if read not advertised
  if (!names.has("read") && (names.has("edit") || names.has("write") || names.has("apply_patch"))) {
    instructions.push(
      "- Never treat a capped/partial file read as complete content. Re-`read` remaining ranges with `offset` before editing or rewriting; do not pass a partial read back as a whole-file replacement.",
    )
  }

  // Search preference — native Devin tips say never use shell rg/grep/find
  if (names.has("grep") || names.has("glob")) {
    const preferred = ["grep", "glob"].filter(n => names.has(n)).map(n => `\`${n}\``).join(" and ")
    instructions.push(
      `- For code search, use OpenCode ${preferred} instead of shell \`rg\`/\`grep\`/\`find\` via \`bash\`.`,
    )
  }

  // Question tool, if advertised, is the way to ask user
  if (names.has("question")) {
    instructions.push("- When user input is required, call the OpenCode `question` tool.")
  }

  const header = `OpenCode exposes exactly these executable tools for this turn: ${[...names].map(n => `\`${n}\``).join(", ")}.`
  const root = `Workspace root: ${JSON.stringify(workspaceRoot)}. Resolve workspace paths against exactly this root; never invent an absolute prefix, and verify uncertain paths with \`glob\`/\`read\` before using them.`
  const footer = "Call only tools in that exact list for ordinary host execution. Emit the actual tool call and wait for its result; never merely claim or summarize that a tool was used."

  return [
    header,
    root,
    ...(instructions.length ? ["Use these OpenCode tools instead of equivalent Devin-native interactions:", ...instructions] : []),
    footer,
  ].join("\n")
}

export function createDevinLanguageModel(
  modelId: string,
  providerId: string,
  options: CreateDevinOptions,
): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: providerId,
    modelId,
    supportedUrls: {},

    async doStream(callOptions: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
      return doStreamImpl(modelId, options, callOptions)
    },
    async doGenerate(callOptions: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
      const stream = await doStreamImpl(modelId, options, callOptions)
      const parts: LanguageModelV3StreamPart[] = []
      const reader = stream.stream.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        parts.push(value)
      }
      return foldStreamParts(parts)
    },
  }
}

async function doStreamImpl(
  modelId: string,
  options: CreateDevinOptions,
  callOptions: LanguageModelV3CallOptions,
): Promise<LanguageModelV3StreamResult> {
  const apiKey = await resolveBearerToken({ accessToken: options.accessToken, apiKey: options.apiKey, baseUrl: options.apiBaseURL ?? devinApiBaseURL() })
  const host = options.apiBaseURL ?? devinApiBaseURL()
  const userJwt = await getCachedUserJwt(apiKey, host, callOptions.abortSignal ?? undefined)

  // Resolve wire model id + variant params mirroring cursor's doStream:
  // OpenCode merges model/variant into providerOptions.devin — we must not
  // leak unrelated options onto the wire.
  const rawProviderOptions = (callOptions as unknown as { providerOptions?: unknown }).providerOptions as
    | Record<string, unknown>
    | undefined
  let devinOpts: Record<string, unknown> | undefined
  if (rawProviderOptions) {
    const maybeNested = (rawProviderOptions as Record<string, unknown>).devin
    if (maybeNested && typeof maybeNested === "object" && !Array.isArray(maybeNested)) {
      devinOpts = maybeNested as Record<string, unknown>
    } else if (
      typeof rawProviderOptions["devinModelId"] === "string" ||
      Object.hasOwn(rawProviderOptions, "devinVariantParameters")
    ) {
      devinOpts = rawProviderOptions as Record<string, unknown>
    }
  }
  const picked = (() => {
    try {
      return extractDevinVariantParameters(devinOpts)
    } catch (e) {
      trace(`devin variant params malformed: ${(e as Error).message}`)
      return undefined
    }
  })()
  // OpenCode id is the base (`claude-opus-5`); Devin wire uid is synthesized
  // from variant params (`claude-opus-5-medium`). Matches Cursor's one-id shape.
  // Prime the alias table from the model cache so bare base ids (e.g. `swe-2`)
  // resolve to their default variant even when OpenCode sends no params.
  // Fire-and-forget is fine: resolveDevinWireModelId falls back to synthesis.
  try {
    const { readCache } = await import("./models.js")
    const { modelsToConfig } = await import("./model-config.js")
    const { opencodeGlobalCacheDir } = await import("./context/paths.js")
    const _c = await readCache(options.cacheDir ?? opencodeGlobalCacheDir())
    if (_c?.models.length) modelsToConfig(_c.models)
  } catch {}
  const wireModelId = resolveDevinWireModelId(devinOpts, modelId, picked)
  if (picked || wireModelId !== modelId) {
    trace(`devin variant: opencodeId=${modelId} wireId=${wireModelId} picked=${picked ? JSON.stringify(picked) : "none"}`)
  }

  // Attachment support (images + video/document from Devin 3.9.19 ModelFeatures)
  const lastUserRaw = [...callOptions.prompt].reverse().find((m) => (m as any).role === "user") as unknown as
    | Record<string, unknown>
    | undefined
  const supportsImages = resolveDevinModelSupportsImages(wireModelId, undefined)
  const supportsVideo = resolveDevinModelSupportsVideo(wireModelId, undefined)
  const supportsDocuments = resolveDevinModelSupportsDocuments(wireModelId, undefined)
  const attachCaps = { supportsImages, supportsVideo, supportsDocuments }
  if (lastUserRaw && hasDevinUserFileAttachments(lastUserRaw)) {
    assertDevinUserAttachmentSupport(lastUserRaw, attachCaps, wireModelId)
  }
  let attachmentExtraction: Awaited<ReturnType<typeof extractDevinPromptAttachments>> | undefined
  try {
    attachmentExtraction = await extractDevinPromptAttachments(
      callOptions.prompt as readonly unknown[],
      lastUserRaw,
      { ...attachCaps, signal: callOptions.abortSignal as AbortSignal | undefined },
    )
    if (attachmentExtraction.duplicateCount > 0) {
      trace(`attachments: skipped ${attachmentExtraction.duplicateCount} duplicate history image(s)`)
    }
    if (attachmentExtraction.attachments.length > 0) {
      const kinds = attachmentExtraction.attachments.map((a) => a.kind).join(",")
      trace(
        `attachments: ${attachmentExtraction.userAttachmentCount} user + `
        + `${attachmentExtraction.attachments.length - attachmentExtraction.userAttachmentCount} history `
        + `for ${wireModelId} kinds=${kinds}`,
      )
    }
  } catch (e) {
    throw e
  }

  const systemPrompt = extractSystemPrompt(callOptions.prompt)
  let messages = extractHistory(callOptions.prompt)
  if (attachmentExtraction?.attachments.length) {
    messages = injectAttachmentsOntoLastUser(
      messages,
      attachmentExtraction.attachments.map(attachmentToContentPart),
    )
  }
  const tools = extractTools(callOptions)
  const workspaceRoot = options.workspaceRoot ?? (callOptions as any).workspaceRoot ?? process.cwd()
  const guidance = buildDevinOpenCodeGuidance(tools, workspaceRoot)
  if (guidance) {
    const sys = systemPrompt ? `${guidance}\n\n${systemPrompt}` : guidance
    messages = [{ role: "system", content: sys }, ...messages]
    trace(`devin guidance: workspaceRoot=${workspaceRoot} tools=${[...new Set(tools.map(t => t.name))].join(",")}`)
  } else if (systemPrompt) {
    messages = [{ role: "system", content: systemPrompt }, ...messages]
  }

  const sessionKey = opencodeSessionKey(callOptions)
  const cascadeId = sessionKey ?? crypto.randomUUID()
  const promptCacheKey = sessionKey ?? cascadeId

  trace(`devin doStream model=${modelId} wire=${wireModelId} host=${host} msgs=${messages.length} tools=${tools.length} toolNames=${tools.map(t => t.name).join(",")} cascade=${cascadeId.slice(0, 8)} cacheKey=${promptCacheKey.slice(0, 8)}`)

  const stream = new ReadableStream<LanguageModelV3StreamPart>({
    async start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] } as LanguageModelV3StreamPart)
      let textId: string | undefined
      let reasoningId: string | undefined
      const toolCalls = new Map<string, { id: string; name: string; args: string }>()
      let finishUnified: LanguageModelV3Usage extends never ? string : "stop" | "tool-calls" | "length" | "content-filter" | "error" | "other" = "other" as any
      let rawFinish: string | undefined
      const counters: DevinUsageCounters = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 }
      let hasUsage = false

      const toFinishReason = (unified: string, raw?: string): any => ({ unified, raw })

      try {
        for await (const ev of streamChatEvents({
          apiKey,
          apiServerUrl: host,
          modelUid: wireModelId,
          messages,
          tools: tools.length ? tools : undefined,
          cascadeId,
          sessionId: cascadeId,
          promptCacheKey,
          signal: callOptions.abortSignal,
          userJwt,
        })) {
          if (callOptions.abortSignal?.aborted) break
          if (ev.kind === "text") {
            if (!textId) {
              textId = crypto.randomUUID()
              controller.enqueue({ type: "text-start", id: textId } as LanguageModelV3StreamPart)
            }
            controller.enqueue({ type: "text-delta", id: textId, delta: ev.text } as LanguageModelV3StreamPart)
          } else if (ev.kind === "reasoning") {
            if (!reasoningId) {
              reasoningId = crypto.randomUUID()
              controller.enqueue({ type: "reasoning-start", id: reasoningId } as LanguageModelV3StreamPart)
            }
            controller.enqueue({ type: "reasoning-delta", id: reasoningId, delta: ev.text } as LanguageModelV3StreamPart)
          } else if (ev.kind === "tool_call_start") {
            toolCalls.set(ev.id, { id: ev.id, name: ev.name, args: "" })
            controller.enqueue({ type: "tool-input-start", id: ev.id, toolName: ev.name } as unknown as LanguageModelV3StreamPart)
          } else if (ev.kind === "tool_call_args") {
            const existing = toolCalls.get(ev.id ?? [...toolCalls.keys()].pop() ?? "")
            if (existing) {
              existing.args += ev.argsDelta
              controller.enqueue({ type: "tool-input-delta", id: existing.id, delta: ev.argsDelta } as unknown as LanguageModelV3StreamPart)
            }
          } else if (ev.kind === "finish") {
            rawFinish = ev.reason
            finishUnified = ev.reason === "tool_calls" ? "tool-calls" : ev.reason === "length" ? "length" : ev.reason === "content_filter" ? "content-filter" : "stop"
          } else if (ev.kind === "usage") {
            hasUsage = true
            if (typeof ev.promptTokens === "number") counters.inputTokens = ev.promptTokens
            if (typeof ev.completionTokens === "number") counters.outputTokens = ev.completionTokens
            if (typeof ev.cacheReadTokens === "number") counters.cacheRead = ev.cacheReadTokens
            else if (typeof ev.cachedTokens === "number") counters.cacheRead = ev.cachedTokens
            if (typeof ev.cacheWriteTokens === "number") counters.cacheWrite = ev.cacheWriteTokens
            // Server may legitimately send cacheRead > input (snapshot of cached context, not partition).
            // Prior build clamped it away — log raw + derived so cache diagnosis is possible.
            if (counters.cacheRead > counters.inputTokens) {
              trace(`devin usage (raw): input=${counters.inputTokens} output=${counters.outputTokens} cacheRead=${counters.cacheRead} cacheWrite=${counters.cacheWrite} — cacheRead > input (server snapshot, not partition; see usage.ts)`)
            } else {
              trace(`devin usage: input=${counters.inputTokens} output=${counters.outputTokens} cacheRead=${counters.cacheRead} cacheWrite=${counters.cacheWrite}`)
            }
          }
        }
      } catch (e) {
        const err = e as Error & { code?: string; transient?: boolean }
        const isQuota = err.code === "failed_precondition" || /quota has been exhausted/i.test(err.message)
        trace(`devin doStream error model=${modelId} host=${host} code=${err.code ?? ""} transient=${String(err.transient ?? "")} error=${err.message} stack=${String((err as any).stack ?? "").slice(0, 800)}`)
        // For quota errors, surface the server message as visible text so the user sees
        // the exact quota/trace ID instead of OpenCode's generic "Provider is overloaded [retrying...]"
        if (isQuota) {
          if (!textId) {
            textId = crypto.randomUUID()
            controller.enqueue({ type: "text-start", id: textId } as LanguageModelV3StreamPart)
          }
          const quotaMsg = `⚠️ Devin quota exhausted: ${err.message}`
          controller.enqueue({ type: "text-delta", id: textId, delta: quotaMsg } as LanguageModelV3StreamPart)
        }
        controller.enqueue({ type: "error", error: err } as LanguageModelV3StreamPart)
        if (textId) controller.enqueue({ type: "text-end", id: textId } as LanguageModelV3StreamPart)
        if (reasoningId) controller.enqueue({ type: "reasoning-end", id: reasoningId } as LanguageModelV3StreamPart)
        const errUsage = hasUsage ? buildLanguageModelV3UsageFromCounters(counters) : emptyLanguageModelV3Usage()
        controller.enqueue({ type: "finish", finishReason: toFinishReason("error", err.message), usage: errUsage, providerMetadata: { devin: { error: err.message } } } as unknown as LanguageModelV3StreamPart)
        controller.close()
        return
      }

      if (textId) controller.enqueue({ type: "text-end", id: textId } as LanguageModelV3StreamPart)
      if (reasoningId) controller.enqueue({ type: "reasoning-end", id: reasoningId } as LanguageModelV3StreamPart)
      // For GPT models where OpenCode swaps edit/write for apply_patch (see
      // src/protocol/apply-patch.ts header / opencode PR #9127), translate Devin's
      // native write/edit calls into apply_patch patches. Keyed off the
      // advertised catalog, not the model id — inert on OpenCode 2.0 and when
      // edit/write are available normally.
      const advertisedNames = new Set(tools.map(t => t.name))
      const schemaOf = (name: string) => tools.find(t => t.name === name)?.parameters
      const needsPatch = !advertisedNames.has("edit") && !advertisedNames.has("write") && advertisedNames.has("apply_patch")
      if (needsPatch) {
        trace(`devin apply_patch bridge: active (catalog=${[...advertisedNames].join(",")}) model=${modelId}`)
      }
      for (const tc of toolCalls.values()) {
        let toolName = tc.name
        let inputStr: string
        let refused: { reason: string; originalTool: string } | null = null
        if (needsPatch && (toolName === "write" || toolName === "edit")) {
          let parsed: unknown
          try { parsed = JSON.parse(tc.args) } catch { parsed = tc.args }
          const workspaceRoot = options.workspaceRoot ?? (callOptions as any).workspaceRoot ?? process.cwd()
          const remapped = remapDevinEditForApplyPatchCatalog({
            toolName,
            input: parsed,
            advertisedToolNames: advertisedNames,
            workspaceRoot,
          })
          if (remapped.type === "patched") {
            toolName = "apply_patch"
            inputStr = JSON.stringify({ patchText: remapped.patchText })
            trace(`devin apply_patch bridge: ${remapped.originalTool} -> apply_patch ${remapped.filePath}`)
            controller.enqueue({ type: "tool-call", toolCallId: tc.id, toolName, input: inputStr } as unknown as LanguageModelV3StreamPart)
            continue
          } else if (remapped.type === "refused") {
            trace(`devin apply_patch bridge refused ${toolName}: ${remapped.reason}`)
            refused = { reason: remapped.reason, originalTool: remapped.originalTool }
          } else {
            const normalized = normalizeFileToolArgs(toolName, parsed, schemaOf(toolName))
            inputStr = typeof normalized === "string" ? normalized : JSON.stringify(normalized)
            controller.enqueue({ type: "tool-call", toolCallId: tc.id, toolName, input: inputStr } as unknown as LanguageModelV3StreamPart)
            continue
          }
        } else {
          let parsed: unknown
          try { parsed = JSON.parse(tc.args) } catch { parsed = tc.args }
          const normalized = normalizeFileToolArgs(toolName, parsed, schemaOf(toolName))
          try {
            const before = typeof parsed === "string" ? parsed : JSON.stringify(parsed)
            const after = typeof normalized === "string" ? normalized : JSON.stringify(normalized)
            if (before !== after) trace(`devin arg normalize ${toolName}: ${before.slice(0, 200)} -> ${after.slice(0, 200)}`)
          } catch {}
          inputStr = typeof normalized === "string" ? normalized : JSON.stringify(normalized)
          controller.enqueue({ type: "tool-call", toolCallId: tc.id, toolName, input: inputStr } as unknown as LanguageModelV3StreamPart)
          continue
        }
        if (refused) {
          const errMsg = `Devin ${refused.originalTool} request cannot be expressed as an apply_patch call: ${refused.reason}. The host advertises \`apply_patch\` instead of \`edit\`/\`write\` for this model.`
          // Emit as apply_patch so OpenCode surfaces a typed error; also warn in text
          controller.enqueue({ type: "tool-call", toolCallId: tc.id, toolName: "apply_patch", input: JSON.stringify({ patchText: `*** Begin Patch\n*** Update File: ${errMsg}\n*** End Patch` }) } as unknown as LanguageModelV3StreamPart)
          if (!textId) {
            textId = crypto.randomUUID()
            controller.enqueue({ type: "text-start", id: textId } as LanguageModelV3StreamPart)
          }
          controller.enqueue({ type: "text-delta", id: textId, delta: `\n\n⚠️ ${errMsg}\n` } as LanguageModelV3StreamPart)
          // keep textId open to be closed by outer finalizer
        }
      }

      if ((finishUnified as string) === "other") finishUnified = (toolCalls.size > 0 ? "tool-calls" : "stop") as any
      const finalUsage = hasUsage ? buildLanguageModelV3UsageFromCounters(counters) : emptyLanguageModelV3Usage()
      // Like cursor's LoggableUsage, expose raw server counters verbatim in providerMetadata
      // alongside the derived AI SDK usage (input/noCache/cacheRead/cacheWrite). Consumers can
      // distinguish warm vs cold by comparing successive turns' cacheRead against prior input.
      const rawCounters = hasUsage ? { inputTokens: counters.inputTokens, outputTokens: counters.outputTokens, cacheRead: counters.cacheRead, cacheWrite: counters.cacheWrite } : undefined
      if (hasUsage && rawCounters && rawCounters.cacheRead > rawCounters.inputTokens) {
        trace(`devin final usage (raw snapshot, cacheRead > input): hasUsage=${hasUsage} input=${rawCounters.inputTokens} output=${rawCounters.outputTokens} cacheRead=${rawCounters.cacheRead} — server reports cumulative cached context, not input partition`)
      } else {
        trace(`devin final usage: hasUsage=${hasUsage} input=${counters.inputTokens} output=${counters.outputTokens} cacheRead=${counters.cacheRead}`)
      }
      controller.enqueue({
        type: "finish",
        finishReason: toFinishReason(finishUnified, rawFinish),
        usage: finalUsage,
        providerMetadata: { devin: { modelId, usageCounters: hasUsage ? counters : undefined, rawCounters, cacheDiagnosis: hasUsage && rawCounters ? `raw input=${rawCounters.inputTokens} output=${rawCounters.outputTokens} cacheRead=${rawCounters.cacheRead} cacheWrite=${rawCounters.cacheWrite}${rawCounters.cacheRead > rawCounters.inputTokens ? " (cacheRead > input — warm cache snapshot)" : ""}` : undefined } },
      } as unknown as LanguageModelV3StreamPart)
      controller.close()
    },
  })

  return { stream }
}

function foldStreamParts(parts: LanguageModelV3StreamPart[]): LanguageModelV3GenerateResult {
  let text = ""
  const toolCalls: Array<{ toolCallId: string; toolName: string; input: string }> = []
  let finishReason: LanguageModelV3GenerateResult["finishReason"] = { unified: "stop", raw: undefined }
  let usage: LanguageModelV3GenerateResult["usage"] = {
    inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  }
  for (const p of parts) {
    const part = p as unknown as Record<string, unknown>
    if (part.type === "text-delta" && typeof part.delta === "string") text += part.delta
    if (part.type === "tool-call") {
      const input = typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? "")
      toolCalls.push({ toolCallId: part.toolCallId as string, toolName: part.toolName as string, input })
    }
    if (part.type === "finish") {
      if (part.finishReason && typeof part.finishReason === "object") finishReason = part.finishReason as LanguageModelV3GenerateResult["finishReason"]
      if (part.usage && typeof part.usage === "object") usage = part.usage as LanguageModelV3GenerateResult["usage"]
    }
  }
  return {
    content: [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...toolCalls.map(tc => ({ type: "tool-call" as const, toolCallId: tc.toolCallId, toolName: tc.toolName, input: tc.input })),
    ],
    finishReason,
    usage,
    warnings: [],
  }
}
