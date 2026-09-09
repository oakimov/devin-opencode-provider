import { describe, it, expect } from "bun:test"
import { buildGetChatMessageRequest, type ChatHistoryItem } from "../src/protocol/chat.js"
import { iterFields } from "../src/protocol/wire.js"

function stringFields(buf: Uint8Array): Map<number, string[]> {
  const out = new Map<number, string[]>()
  for (const f of iterFields(buf)) {
    if (f.wire === 2 && f.value instanceof Uint8Array) {
      const list = out.get(f.num) ?? []
      list.push(new TextDecoder().decode(f.value))
      out.set(f.num, list)
    }
  }
  return out
}

function nestedMessages(buf: Uint8Array): Uint8Array[] {
  const msgs: Uint8Array[] = []
  for (const f of iterFields(buf)) {
    if (f.num === 3 && f.wire === 2 && f.value instanceof Uint8Array) msgs.push(f.value)
  }
  return msgs
}

describe("buildGetChatMessageRequest 3.9.19 wire fields", () => {
  const base = {
    apiKey: "k",
    userJwt: "jwt",
    modelUid: "claude-opus-5-medium",
    cascadeId: "cascade-stable",
    promptId: "prompt-1",
    sessionId: "session-stable",
    promptCacheKey: "cache-key-1",
    requestId: 1n,
    triggerId: "trig",
  }

  it("encodes prompt_id #17, execution_id #22, prompt_cache_key #27", () => {
    const msgs: ChatHistoryItem[] = [{ role: "user", content: "hi" }]
    const req = buildGetChatMessageRequest({ ...base, messages: msgs })
    const top = stringFields(req)
    expect(top.get(16)?.[0]).toBe("cascade-stable")
    expect(top.get(17)?.[0]).toBe("prompt-1")
    expect(top.get(21)?.[0]).toBe("claude-opus-5-medium")
    expect(top.get(22)?.[0]).toBe("prompt-1")
    expect(top.get(27)?.[0]).toBe("cache-key-1")
  })

  it("encodes VideoData #20 and DocumentData #21 on user prompts", () => {
    const msgs: ChatHistoryItem[] = [{
      role: "user",
      content: [
        { type: "text", text: "review" },
        { type: "video", mimeType: "video/mp4", url: "https://cdn.example/a.mp4" },
        {
          type: "document",
          mimeType: "application/pdf",
          filename: "spec.pdf",
          base64Data: Buffer.from("%PDF").toString("base64"),
        },
      ],
    }]
    const req = buildGetChatMessageRequest({ ...base, messages: msgs })
    const [prompt] = nestedMessages(req)
    expect(prompt).toBeTruthy()
    const fields = [...iterFields(prompt!)]
    const videos = fields.filter((f) => f.num === 20 && f.wire === 2)
    const docs = fields.filter((f) => f.num === 21 && f.wire === 2)
    expect(videos.length).toBe(1)
    expect(docs.length).toBe(1)
    const videoInner = stringFields(videos[0]!.value as Uint8Array)
    expect(videoInner.get(3)?.[0]).toBe("https://cdn.example/a.mp4")
    const docInner = stringFields(docs[0]!.value as Uint8Array)
    expect(docInner.get(3)?.[0]).toBe("spec.pdf")
  })

  it("encodes assistant thinking on #11", () => {
    const msgs: ChatHistoryItem[] = [{
      role: "assistant",
      content: "answer",
      thinking: "need to reason",
    }]
    const req = buildGetChatMessageRequest({ ...base, messages: msgs })
    const [prompt] = nestedMessages(req)
    const fields = [...iterFields(prompt!)]
    const thinking = fields.find((f) => f.num === 11 && f.wire === 2)
    expect(thinking).toBeTruthy()
    expect(new TextDecoder().decode(thinking!.value as Uint8Array)).toBe("need to reason")
  })
})
