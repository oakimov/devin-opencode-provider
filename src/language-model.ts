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
      const toolResult = m as unknown as { role: "tool"; toolCallId: string; toolName?: string; result?: unknown; content?: unknown }
      const resultText = typeof toolResult.result === "string" ? toolResult.result : JSON.stringify(toolResult.result ?? toolResult.content ?? "")
      out.push({ role: "tool", content: resultText, tool_call_id: toolResult.toolCallId })
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
  if (systemPrompt) messages = [{ role: "system", content: systemPrompt }, ...messages]
  const tools = extractTools(callOptions)

  trace(`devin doStream model=${modelId} host=${host} msgs=${messages.length} tools=${tools.length}`)

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
            trace(`devin usage: input=${counters.inputTokens} output=${counters.outputTokens} cacheRead=${counters.cacheRead} cacheWrite=${counters.cacheWrite}`)
          }
        }
      } catch (e) {
        const err = e as Error
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
      // Ensure OpenCode session debug shows usage validation like cursor
      trace(`devin final usage: hasUsage=${hasUsage} input=${counters.inputTokens} output=${counters.outputTokens} cacheRead=${counters.cacheRead}`)
      controller.enqueue({
        type: "finish",
        finishReason: toFinishReason(finishUnified, rawFinish),
        usage: finalUsage,
        providerMetadata: { devin: { modelId, usageCounters: hasUsage ? counters : undefined } },
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
