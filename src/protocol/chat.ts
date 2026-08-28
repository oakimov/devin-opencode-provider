import * as crypto from "node:crypto"
import * as zlib from "node:zlib"
import { concat, encodeMessage, encodeString, encodeVarintField, frameEnvelope, iterFields, parseConnectFrames } from "./wire.js"
import { buildMetadata } from "./metadata.js"

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; base64Data: string; caption?: string }

export type ChatHistoryItem = {
  role: "user" | "assistant" | "system" | "tool"
  content: string | ContentPart[]
  tool_call_id?: string
  tool_calls?: Array<{ id: string; name: string; arguments: string }>
}

export type ToolDef = {
  name: string
  description: string
  parameters: unknown
}

export type CloudChatEvent =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_call_start"; id: string; name: string }
  | { kind: "tool_call_args"; argsDelta: string; id?: string }
  | { kind: "finish"; reason: "stop" | "tool_calls" | "length" | "content_filter" }
  | {
      kind: "usage"
      promptTokens?: number
      completionTokens?: number
      totalTokens?: number
      cachedTokens?: number
      cacheReadTokens?: number
      cacheWriteTokens?: number
    }

function encodeImageData(img: { mimeType: string; base64Data: string; caption?: string }): Uint8Array {
  const parts: Uint8Array[] = [
    encodeString(1, img.base64Data),
    encodeString(2, img.mimeType),
  ]
  if (img.caption) parts.push(encodeString(3, img.caption))
  return concat(...parts)
}

function encodeChatToolCall(tc: { id: string; name: string; arguments: string }): Uint8Array {
  return concat(
    encodeString(1, tc.id),
    encodeString(2, tc.name),
    encodeString(3, tc.arguments),
  )
}

const SOURCE_BY_ROLE: Record<string, number> = {
  user: 1,
  assistant: 2,
  system: 1,
  tool: 4,
}

function normalizeContent(content: string | ContentPart[] | unknown): ContentPart[] {
  if (typeof content === "string") return [{ type: "text", text: content }]
  if (!Array.isArray(content)) return []
  const out: ContentPart[] = []
  for (const p of content as Array<Record<string, unknown>>) {
    if (!p || typeof p !== "object") continue
    if (p.type === "text" && typeof p.text === "string") out.push({ type: "text", text: p.text })
    else if (p.type === "image" && typeof p.base64Data === "string") {
      out.push({ type: "image", mimeType: typeof p.mimeType === "string" ? p.mimeType : "image/png", base64Data: p.base64Data, caption: typeof p.caption === "string" ? p.caption : undefined })
    } else if (p.type === "image_url" && (p as any).image_url) {
      const imgRef = (p as any).image_url as string | { url?: string }
      const url: string = typeof imgRef === "string" ? imgRef : (imgRef.url ?? "")
      const m = url.match(/^data:([^;]+);base64,(.+)$/)
      if (m) out.push({ type: "image", mimeType: m[1], base64Data: m[2] })
    }
  }
  return out
}

function collapseSystemIntoUser(messages: ChatHistoryItem[]): ChatHistoryItem[] {
  const out: ChatHistoryItem[] = []
  let pending: string[] = []
  const flush = (c: ContentPart[]) => c.filter((p): p is { type: "text"; text: string } => p.type === "text").map(p => p.text).join("\n")
  for (const m of messages) {
    if (m.role === "system") {
      const t = flush(normalizeContent(m.content))
      if (t) pending.push(t)
    } else if (m.role === "user" && pending.length) {
      const parts = normalizeContent(m.content)
      const userText = flush(parts)
      const images = parts.filter(p => p.type === "image")
      const wrapped = `<system>\n${pending.join("\n\n")}\n</system>\n${userText}`
      out.push({ role: "user", content: [{ type: "text", text: wrapped }, ...images] })
      pending = []
    } else {
      out.push(m)
    }
  }
  if (pending.length) out.push({ role: "user", content: [{ type: "text", text: `<system>\n${pending.join("\n\n")}\n</system>` }] })
  return out
}

function encodeChatMessagePrompt(content: ContentPart[], source: number, opts?: { toolCallId?: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> }): Uint8Array {
  const textParts = content.filter((p): p is { type: "text"; text: string } => p.type === "text")
  const imageParts = content.filter((p): p is { type: "image"; mimeType: string; base64Data: string; caption?: string } => p.type === "image")
  const joined = textParts.map(p => p.text).join("\n")
  const parts: Uint8Array[] = [
    encodeVarintField(2, source),
    encodeString(3, joined),
    encodeVarintField(4, Math.max(1, Math.floor(joined.length / 4))),
    encodeVarintField(5, 1),
  ]
  if (opts?.toolCallId) parts.push(encodeString(7, opts.toolCallId))
  if (opts?.toolCalls?.length) {
    for (const tc of opts.toolCalls) parts.push(encodeMessage(6, encodeChatToolCall(tc)))
  }
  for (const img of imageParts) parts.push(encodeMessage(10, encodeImageData(img)))
  return concat(...parts)
}

const MAX_TOOL_DESC_LEN = 6998
function encodeToolDef(tool: ToolDef): Uint8Array {
  const rawDesc = tool.description ?? ""
  const desc = rawDesc.length > MAX_TOOL_DESC_LEN ? rawDesc.slice(0, MAX_TOOL_DESC_LEN - 24) + "\n...(truncated)" : rawDesc
  return concat(
    encodeString(1, tool.name),
    encodeString(2, desc),
    encodeString(3, JSON.stringify(tool.parameters ?? {})),
  )
}

function encodeCompletionConfiguration(opts: { maxOutputTokens?: number; temperature?: number; topP?: number; topK?: number } = {}): Uint8Array {
  const enc64 = (fieldNum: number, n: number): Uint8Array => {
    const b = Buffer.alloc(8)
    b.writeDoubleLE(n, 0)
    return concat(Uint8Array.from([(fieldNum << 3) | 1]), new Uint8Array(b))
  }
  return concat(
    encodeVarintField(1, 1),
    encodeVarintField(2, 64000),
    encodeVarintField(3, opts.maxOutputTokens ?? 128_000),
    enc64(5, opts.temperature ?? 0.7),
    enc64(6, opts.topP ?? 0.95),
    encodeVarintField(7, opts.topK ?? 50),
    enc64(8, 1.0),
    enc64(11, 1.0),
  )
}

type BuildArgs = {
  apiKey: string
  userJwt: string
  modelUid: string
  messages: ChatHistoryItem[]
  cascadeId: string
  promptId: string
  sessionId: string
  requestId: bigint
  triggerId: string
  tools?: ToolDef[]
  requestType?: number
  completionOpts?: { maxOutputTokens?: number; temperature?: number; topP?: number; topK?: number }
}

export function buildGetChatMessageRequest(args: BuildArgs): Uint8Array {
  const metadata = buildMetadata({ apiKey: args.apiKey, userJwt: args.userJwt, sessionId: args.sessionId, requestId: args.requestId, triggerId: args.triggerId })
  const collapsed = collapseSystemIntoUser(args.messages)
  const promptParts = collapsed.map(m => encodeMessage(3, encodeChatMessagePrompt(normalizeContent(m.content), SOURCE_BY_ROLE[m.role] ?? 1, { toolCallId: m.role === "tool" ? m.tool_call_id : undefined, toolCalls: m.role === "assistant" ? m.tool_calls : undefined })))
  const completion = encodeCompletionConfiguration(args.completionOpts ?? {})
  const toolParts: Uint8Array[] = (args.tools ?? []).map(t => encodeMessage(10, encodeToolDef(t)))
  return concat(
    encodeMessage(1, metadata),
    ...promptParts,
    encodeVarintField(7, args.requestType ?? 5),
    encodeMessage(8, completion),
    ...toolParts,
    encodeString(16, args.cascadeId),
    encodeString(21, args.modelUid),
    encodeString(22, args.promptId),
  )
}

function* decodeChatFrame(proto: Uint8Array): Generator<CloudChatEvent> {
  for (const f of iterFields(proto)) {
    if (f.num === 3 && f.wire === 2 && f.value instanceof Uint8Array) {
      const s = new TextDecoder().decode(f.value)
      if (s) yield { kind: "text", text: s }
    } else if (f.num === 9 && f.wire === 2 && f.value instanceof Uint8Array) {
      const s = new TextDecoder().decode(f.value)
      if (s) yield { kind: "reasoning", text: s }
    } else if (f.num === 6 && f.wire === 2 && f.value instanceof Uint8Array) {
      let id: string | undefined
      let name: string | undefined
      let argsDelta: string | undefined
      for (const sf of iterFields(f.value)) {
        if (sf.wire === 2 && sf.value instanceof Uint8Array) {
          const s = new TextDecoder().decode(sf.value)
          if (sf.num === 1) id = s
          else if (sf.num === 2) name = s
          else if (sf.num === 3) argsDelta = s
        }
      }
      if (id !== undefined && name !== undefined) yield { kind: "tool_call_start", id, name }
      if (argsDelta !== undefined) yield { kind: "tool_call_args", argsDelta, ...(id !== undefined ? { id } : {}) }
    } else if (f.num === 5 && f.wire === 0) {
      const v = Number(f.value)
      let reason: "stop" | "tool_calls" | "length" | "content_filter" = "stop"
      if (v === 10) reason = "tool_calls"
      else if (v === 11) reason = "content_filter"
      else if (v === 1 || v === 3) reason = "length"
      yield { kind: "finish", reason }
    } else if (f.num === 7 && f.wire === 2 && f.value instanceof Uint8Array) {
      // #7 can be either metadata (first frame) or ModelUsageStats (closing).
      // Distinguish by presence of #2 input / #3 output.
      let inputTokens: number | undefined
      let outputTokens: number | undefined
      let cacheRead: number | undefined
      let cacheWrite: number | undefined
      let hasUsage = false
      for (const sf of iterFields(f.value)) {
        if (sf.wire === 0) {
          const v = Number(sf.value)
          if (sf.num === 2) { inputTokens = v; hasUsage = true }
          else if (sf.num === 3) { outputTokens = v; hasUsage = true }
          else if (sf.num === 5) { cacheRead = v; hasUsage = true }
          else if (sf.num === 4) { cacheWrite = v; hasUsage = true }
        }
      }
      if (hasUsage && (inputTokens !== undefined || outputTokens !== undefined)) {
        yield {
          kind: "usage",
          promptTokens: inputTokens,
          completionTokens: outputTokens,
          totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          cachedTokens: cacheRead,
        }
      }
    } else if (f.num === 28 && f.wire === 2 && f.value instanceof Uint8Array) {
      // Response Statistics — contains aggregated usage in some captures, but primary is #7.
      // Parse #28 as fallback: look for nested #2 entries with metric_id
      const usage = decodeUsageBlock(f.value)
      if (usage) yield usage
    }
  }
}

function decodeUsageBlock(buf: Uint8Array): CloudChatEvent | null {
  // Fallback for #28 Response Statistics block (rsvedant style) — not primary for devin but handle if present
  let promptTokens: number | undefined
  let completionTokens: number | undefined
  let cachedTokens: number | undefined
  for (const f of iterFields(buf)) {
    if (f.num !== 2 || f.wire !== 2 || !(f.value instanceof Uint8Array)) continue
    let metric: string | undefined
    let value: number | undefined
    for (const sf of iterFields(f.value)) {
      if (sf.num === 5 && sf.wire === 2) metric = Buffer.from(sf.value as Uint8Array).toString()
      else if (sf.num === 4 && sf.wire === 2) {
        for (const ssf of iterFields(sf.value as Uint8Array)) {
          if (ssf.num === 2 && ssf.wire === 5) value = Buffer.from(ssf.value as Uint8Array).readFloatLE(0)
        }
      }
    }
    if (metric && value !== undefined && Number.isFinite(value)) {
      const n = Math.round(value)
      if (metric === "input_tokens") promptTokens = n
      else if (metric === "output_tokens") completionTokens = n
      else if (metric === "cached_tokens" || metric === "cache_read_input_tokens") cachedTokens = n
    }
  }
  if (promptTokens === undefined && completionTokens === undefined) return null
  return {
    kind: "usage",
    promptTokens,
    completionTokens,
    totalTokens: (promptTokens ?? 0) + (completionTokens ?? 0),
    cachedTokens,
    cacheReadTokens: cachedTokens,
  }
}

export class CloudChatError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message)
    this.name = "CloudChatError"
  }
}

function frameConnectStream(proto: Uint8Array, gzip: boolean): Uint8Array {
  let payload = proto
  let flags = 0x00
  if (gzip) {
    payload = zlib.gzipSync(proto)
    flags |= 0x01
  }
  return frameEnvelope(payload, flags)
}

export async function* streamChatEvents(req: {
  apiKey: string
  apiServerUrl?: string
  modelUid: string
  messages: ChatHistoryItem[]
  tools?: ToolDef[]
  cascadeId?: string
  signal?: AbortSignal
  userJwt: string
}): AsyncGenerator<CloudChatEvent> {
  const host = (req.apiServerUrl ?? "https://server.codeium.com").replace(/\/$/, "")
  const cascadeId = req.cascadeId ?? crypto.randomUUID()
  const proto = buildGetChatMessageRequest({
    apiKey: req.apiKey,
    userJwt: req.userJwt,
    modelUid: req.modelUid,
    messages: req.messages,
    tools: req.tools,
    cascadeId,
    promptId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    requestId: BigInt(Date.now()),
    triggerId: crypto.randomUUID(),
  })
  const body = frameConnectStream(proto, true)
  const resp = await fetch(`${host}/exa.api_server_pb.ApiServerService/GetChatMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/connect+proto",
      "Connect-Protocol-Version": "1",
      "Connect-Content-Encoding": "gzip",
      "Connect-Accept-Encoding": "gzip",
    },
    body: body as unknown as BodyInit,
    signal: req.signal,
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => "")
    throw new CloudChatError(`GetChatMessage HTTP ${resp.status}: ${text.slice(0, 400)}`, String(resp.status))
  }
  if (!resp.body) throw new CloudChatError("No body stream")
  const reader = resp.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
  let queued: Uint8Array[] = []
  let queuedBytes = 0
  const peek = (n: number): Uint8Array | null => {
    if (queuedBytes < n) return null
    if (queued.length === 1 && queued[0].length >= n) return queued[0].slice(0, n)
    const parts: Uint8Array[] = []
    let rem = n
    for (const c of queued) {
      if (rem <= 0) break
      if (c.length <= rem) { parts.push(c); rem -= c.length } else { parts.push(c.slice(0, rem)); rem = 0 }
    }
    const total = n
    const out = new Uint8Array(total)
    let off = 0
    for (const p of parts) { out.set(p, off); off += p.length }
    return out
  }
  const drop = (n: number): void => {
    queuedBytes -= n
    let rem = n
    while (rem > 0 && queued.length) {
      const h = queued[0]
      if (h.length <= rem) { queued.shift(); rem -= h.length } else { queued[0] = h.slice(rem); rem = 0 }
    }
  }
  let sawEos = false
  let trailerError: { code?: string; message: string } | null = null
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) { queued.push(value); queuedBytes += value.length }
    while (queuedBytes >= 5) {
      const header = peek(5)
      if (!header) break
      const flags = header[0]
      const len = new DataView(header.buffer, header.byteOffset + 1, 4).getUint32(0, false)
      if (queuedBytes < 5 + len) break
      drop(5)
      const raw = peek(len) ?? new Uint8Array(0)
      drop(len)
      let payload = raw
      if (flags & 0x01) {
        try { payload = zlib.gunzipSync(raw as Buffer) } catch (e) { throw new CloudChatError(`gunzip failed: ${(e as Error).message}`) }
      }
      const eos = (flags & 0x02) !== 0
      if (eos) {
        sawEos = true
        const text = new TextDecoder().decode(payload)
        if (text && text.includes('"error"')) {
          try {
            const j = JSON.parse(text) as { error?: { code?: string; message?: string } }
            if (j.error?.message) trailerError = { code: j.error.code, message: j.error.message }
          } catch { trailerError = { message: text } }
        }
        continue
      }
      yield* decodeChatFrame(payload)
    }
  }
  if (trailerError) throw new CloudChatError(trailerError.message, trailerError.code)
  if (!sawEos) {
    // tolerate missing EOS for some mocks
  }
}
