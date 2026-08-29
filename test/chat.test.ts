import { describe, it, expect } from "bun:test"
import { encodeMessage, encodeString, concat, iterFields } from "../src/protocol/wire.js"
import { buildMetadata } from "../src/protocol/metadata.js"

describe("chat protocol encoding", () => {
  it("builds GetChatMessage-like request structure", () => {
    const meta = buildMetadata({ apiKey: "test-key" })
    const modelId = encodeString(4, "swe-1-6")
    const text = encodeString(6, "hello")
    const req = concat(meta, modelId, text)
    expect(req.length).toBeGreaterThan(0)
    const fields = iterFields(req)
    expect(fields.length).toBeGreaterThan(0)
  })

  it("encodes chat history items as proto fields", () => {
    const userMsg = encodeMessage(2, encodeString(1, "user message"))
    const assistantMsg = encodeMessage(2, encodeString(1, "assistant message"))
    const combined = concat(userMsg, assistantMsg)
    expect(combined.length).toBeGreaterThan(0)
    const fields = iterFields(combined)
    expect(fields.filter(f => f.num === 2).length).toBe(2)
  })

  it("encodes tool definitions", () => {
    const toolName = encodeString(1, "read")
    const toolDesc = encodeString(2, "Read a file")
    const tool = encodeMessage(3, concat(toolName, toolDesc))
    const fields = iterFields(tool)
    expect(fields.length).toBeGreaterThan(0)
  })

  it("handles empty messages", () => {
    const empty = new Uint8Array([])
    expect(iterFields(empty)).toEqual([])
  })

  it("encodes system prompt", () => {
    const sys = encodeString(1, "You are a helpful assistant")
    const fields = iterFields(sys)
    expect(new TextDecoder().decode(fields[0].value as Uint8Array)).toBe("You are a helpful assistant")
  })

  it("encodes multiple content parts", () => {
    const parts = [encodeString(1, "part1"), encodeString(1, "part2"), encodeString(1, "part3")]
    const combined = concat(...parts)
    const fields = iterFields(combined)
    expect(fields.length).toBe(3)
  })
})
