import { describe, it, expect } from "bun:test"
import {
  encodeVarint, encodeTag, encodeString, encodeVarintField, encodeMessage, concat, frameEnvelope, iterFields, parseConnectFrames,
} from "../src/protocol/wire.js"

describe("wire encoding", () => {
  it("encodes varint 0 and small numbers", () => {
    expect(encodeVarint(0)).toEqual(new Uint8Array([0]))
    expect(encodeVarint(1)).toEqual(new Uint8Array([1]))
    expect(encodeVarint(127)).toEqual(new Uint8Array([127]))
    expect(encodeVarint(128)).toEqual(new Uint8Array([0x80, 0x01]))
  })

  it("encodes large varints", () => {
    expect(encodeVarint(300).length).toBeGreaterThan(1)
    expect(encodeVarint(1_000_000).length).toBeGreaterThan(2)
    // roundtrip via iterFields
    const enc = encodeVarintField(1, 300)
    const fields = iterFields(enc)
    expect(fields[0].value).toBe(300n)
  })

  it("encodes tags", () => {
    expect(encodeTag(1, 0)).toEqual(new Uint8Array([0x08]))
    expect(encodeTag(2, 2)).toEqual(new Uint8Array([0x12]))
    expect(encodeTag(15, 2)).toEqual(encodeVarint((15 << 3) | 2))
  })

  it("encodes strings with length prefix", () => {
    const enc = encodeString(1, "hello")
    const fields = iterFields(enc)
    expect(fields[0].num).toBe(1)
    expect(new TextDecoder().decode(fields[0].value as Uint8Array)).toBe("hello")
  })

  it("encodes empty and unicode strings", () => {
    expect(new TextDecoder().decode((iterFields(encodeString(1, ""))[0].value as Uint8Array))).toBe("")
    expect(new TextDecoder().decode((iterFields(encodeString(1, "🌍 hello"))[0].value as Uint8Array))).toBe("🌍 hello")
  })

  it("encodes varint fields", () => {
    const enc = encodeVarintField(5, 42)
    const fields = iterFields(enc)
    expect(fields[0].num).toBe(5)
    expect(fields[0].value).toBe(42n)
  })

  it("encodes nested messages", () => {
    const inner = encodeString(1, "inner")
    const outer = encodeMessage(2, inner)
    const fields = iterFields(outer)
    expect(fields[0].num).toBe(2)
    const nested = iterFields(fields[0].value as Uint8Array)
    expect(new TextDecoder().decode(nested[0].value as Uint8Array)).toBe("inner")
  })

  it("concatenates byte arrays", () => {
    expect(Array.from(concat(new Uint8Array([1, 2]), new Uint8Array([3, 4])))).toEqual([1, 2, 3, 4])
    expect(concat().length).toBe(0)
    expect(concat(new Uint8Array([1])).length).toBe(1)
  })

  it("frames envelope with flags and length", () => {
    const payload = new Uint8Array([1, 2, 3, 4])
    const framed = frameEnvelope(payload, 0x00)
    expect(framed[0]).toBe(0x00)
    // length is big-endian uint32 after flags
    const len = (framed[1] << 24) | (framed[2] << 16) | (framed[3] << 8) | framed[4]
    expect(len).toBe(payload.length)
    expect(framed.slice(5)).toEqual(payload)
  })

  it("iterFields handles empty and multiple fields", () => {
    expect(iterFields(new Uint8Array([]))).toEqual([])
    const enc = concat(encodeString(1, "a"), encodeString(2, "b"), encodeVarintField(3, 7))
    const fields = iterFields(enc)
    expect(fields.map(f => f.num)).toEqual([1, 2, 3])
  })

  it("parseConnectFrames single and multiple", () => {
    const p1 = new Uint8Array([1, 2])
    const p2 = new Uint8Array([3, 4, 5])
    const f1 = frameEnvelope(p1, 0x00)
    const f2 = frameEnvelope(p2, 0x01)
    expect(parseConnectFrames(f1)).toHaveLength(1)
    expect(parseConnectFrames(concat(f1, f2))).toHaveLength(2)
    expect(parseConnectFrames(new Uint8Array([]))).toEqual([])
  })

  it("preserves flags through parse", () => {
    const payload = new Uint8Array([9, 9])
    const framed = frameEnvelope(payload, 0x02)
    const frames = parseConnectFrames(framed)
    expect(frames[0].flags).toBe(0x02)
    expect(frames[0].payload).toEqual(payload)
  })

  it("roundtrips wire through iterFields for metadata-like message", () => {
    const msg = concat(encodeString(1, "windsurf"), encodeString(2, "1.48.2"), encodeVarintField(9, 12345))
    const fields = iterFields(msg)
    expect(fields.length).toBe(3)
    expect(fields[0].num).toBe(1)
    expect(fields[2].value).toBe(12345n)
  })
})
