import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamResult, LanguageModelV3GenerateResult, LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider"
import type { CreateDevinOptions } from "./index.js"
import { getCachedUserJwt, resolveBearerToken } from "./auth.js"
import { devinApiBaseURL } from "./plugin-core.js"
import { trace } from "./debug.js"
import type { ChatHistoryItem, ToolDef } from "./protocol/chat.js"
import { streamChatEvents } from "./protocol/chat.js"
import { buildLanguageModelV3UsageFromCounters, emptyLanguageModelV3Usage, type DevinUsageCounters } from "./usage.js"

function extractSystemPrompt(prompt: LanguageModelV3CallOptions["prompt"]): string | undefined {
  const sys = prompt.filter(m => m.role === "system").map(m => {
    const c = (m as any).content
    if (typeof c === "string") return c
    if (Array.isArray(c)) return c.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n")
    return ""
  }).join("\n\n")
  return sys || undefined
}

function extractHistory(prompt: LanguageModelV3CallOptions["prompt"]): ChatHistoryItem[] {
  const out: ChatHistoryItem[] = []
  for (const m of prompt) {
    if (m.role === "system") continue
    if (m.role === "user") {
      const c = (m as any).content
      let content: string | any[] = ""
      if (typeof c === "string") content = c
      else if (Array.isArray(c)) content = c.map((p: any) => {
        if (p.type === "text") return { type: "text", text: p.text }
        if (p.type === "image") return { type: "image", mimeType: p.mediaType ?? "image/png", base64Data: typeof p.image === "string" ? p.image : "" }
        if (p.type === "file") return { type: "text", text: `[file: ${p.filename ?? "file"}]` }
        return { type: "text", text: String(p.text ?? "") }
      })
      else content = String(c ?? "")
      out.push({ role: "user", content } as ChatHistoryItem)
    } else if (m.role === "assistant") {
      const c = (m as any).content
      let text = ""
      if (typeof c === "string") text = c
      else if (Array.isArray(c)) text = c.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n")
      const toolCalls = (m as any).toolCalls as Array<{ toolCallId: string; toolName: string; input: unknown }> | undefined
      out.push({
        role: "assistant",
        content: text,
        tool_calls: toolCalls?.map(tc => ({ id: tc.toolCallId, name: tc.toolName, arguments: JSON.stringify(tc.input ?? {}) })),
      })
    } else if ((m as any).role === "tool") {
      const raw = m as unknown as { role: "tool"; toolCallId: string; toolName?: string; name?: string; result?: unknown; content?: unknown; output?: unknown }
      const text = toolResultToText({ toolName: raw.toolName ?? raw.name, result: raw.result ?? raw.content ?? raw.output ?? raw })
      out.push({ role: "tool", content: text, tool_call_id: raw.toolCallId })
    }
  }
  return out
}

function extractTools(callOptions: LanguageModelV3CallOptions): ToolDef[] {
  const tools = (callOptions as any).tools as Array<{ name: string; description?: string; inputSchema?: unknown }> | undefined
  if (!Array.isArray(tools)) return []
  return tools.map(t => ({
    name: t.name,
    description: t.description ?? "",
    parameters: (t as any).inputSchema ?? (t as any).parameters ?? { type: "object", properties: {} },
  }))
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
  const instructions: string[] = []

  // File mutation preference — opencode offers edit/write directly, not via shell
  if (names.has("write")) {
    instructions.push(
      names.has("edit")
        ? "- For file changes, use OpenCode `edit` for targeted changes to existing files and `write` to create files or intentionally replace complete contents; do not use shell, Python, or heredocs to change file content while these tools are available."
        : "- Use OpenCode `write` for file-content changes; do not use shell, Python, or heredocs to change file content while it is available.",
    )
  } else if (names.has("apply_patch")) {
    instructions.push(
      "- Use OpenCode `apply_patch` for file-content changes; do not use shell, Python, or heredocs to change file content while it is available.",
    )
  }

  // Read capping — opencode caps at 50 KB, Devin native does not (50 MB limit)
  if (names.has("read") || names.has("edit") || names.has("write") || names.has("apply_patch")) {
    instructions.push(
      "- Never use a read result as complete file content when it says the output is capped, partial, or requires another offset. Read the remaining ranges first, or make a targeted edit/patch from complete context; do not pass a partial read back as a whole-file replacement.",
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
  const root = `Workspace root: ${JSON.stringify(workspaceRoot)}. Resolve workspace paths against exactly this root; never invent an absolute prefix, and verify uncertain paths with an available tool before using them.`
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

  const systemPrompt = extractSystemPrompt(callOptions.prompt)
  let messages = extractHistory(callOptions.prompt)
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

  trace(`devin doStream model=${modelId} host=${host} msgs=${messages.length} tools=${tools.length} toolNames=${tools.map(t => t.name).join(",")}`)

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
        for await (const ev of streamChatEvents({ apiKey, apiServerUrl: host, modelUid: modelId, messages, tools: tools.length ? tools : undefined, signal: callOptions.abortSignal, userJwt })) {
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
      for (const tc of toolCalls.values()) {
        let parsed: unknown = tc.args
        try { parsed = JSON.parse(tc.args) } catch {}
        const input = typeof parsed === "string" ? parsed : JSON.stringify(parsed)
        controller.enqueue({ type: "tool-call", toolCallId: tc.id, toolName: tc.name, input } as unknown as LanguageModelV3StreamPart)
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
