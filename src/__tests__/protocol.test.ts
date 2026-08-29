import { describe, it, expect } from "bun:test"
import { encodeVarint, encodeString, encodeVarintField, encodeMessage, concat, frameEnvelope, iterFields, parseConnectFrames, decodeUserJwtResponse } from "../protocol/wire.js"

describe("protocol/wire", () => {
  describe("encodeVarint", () => {
    it("encodes small numbers correctly", () => {
      const result = encodeVarint(42)
      expect(result).toEqual(new Uint8Array([42]))
    })

    it("encodes numbers requiring multiple bytes", () => {
      const result = encodeVarint(300)
      expect(result.length).toBeGreaterThan(1)
    })

    it("encodes zero correctly", () => {
      const result = encodeVarint(0)
      expect(result).toEqual(new Uint8Array([0]))
    })
  })

  describe("encodeString", () => {
    it("encodes simple strings", () => {
      const result = encodeString(1, "hello")
      expect(result.length).toBeGreaterThan(0)
    })

    it("encodes empty strings", () => {
      const result = encodeString(1, "")
      expect(result.length).toBeGreaterThan(0)
    })

    it("encodes unicode strings", () => {
      const result = encodeString(1, "hello 🌍")
      expect(result.length).toBeGreaterThan(0)
    })
  })

  describe("encodeVarintField", () => {
    it("encodes varint fields correctly", () => {
      const result = encodeVarintField(1, 42)
      expect(result.length).toBeGreaterThan(0)
    })
  })

  describe("encodeMessage", () => {
    it("encodes nested messages", () => {
      const inner = encodeString(1, "test")
      const result = encodeMessage(2, inner)
      expect(result.length).toBeGreaterThan(0)
    })
  })

  describe("concat", () => {
    it("concatenates byte arrays", () => {
      const a = new Uint8Array([1, 2, 3])
      const b = new Uint8Array([4, 5, 6])
      const result = concat(a, b)
      expect(Array.from(result)).toEqual([1, 2, 3, 4, 5, 6])
    })

    it("handles empty arrays", () => {
      const result = concat()
      expect(result.length).toBe(0)
    })
  })

  describe("frameEnvelope", () => {
    it("creates Connect streaming envelope", () => {
      const payload = new Uint8Array([1, 2, 3, 4])
      const result = frameEnvelope(payload, 0x00)
      expect(result.length).toBe(5 + payload.length)
      expect(result[0]).toBe(0x00)
    })

    it("sets flags correctly", () => {
      const payload = new Uint8Array([1, 2, 3])
      const result = frameEnvelope(payload, 0x01)
      expect(result[0]).toBe(0x01)
    })
  })

  describe("iterFields", () => {
    it("iterates over simple proto fields", () => {
      const encoded = encodeString(1, "test")
      const fields = iterFields(encoded)
      expect(fields.length).toBeGreaterThan(0)
      expect(fields[0]?.num).toBe(1)
    })

    it("handles empty buffers", () => {
      const fields = iterFields(new Uint8Array([]))
      expect(fields).toEqual([])
    })

    it("handles varint fields", () => {
      const encoded = encodeVarintField(1, 42)
      const fields = iterFields(encoded)
      expect(fields.length).toBeGreaterThan(0)
    })
  })

  describe("parseConnectFrames", () => {
    it("parses single frame", () => {
      const payload = new Uint8Array([1, 2, 3])
      const framed = frameEnvelope(payload, 0x00)
      const frames = parseConnectFrames(framed)
      expect(frames.length).toBe(1)
      expect(frames[0]?.flags).toBe(0x00)
      expect(Array.from(frames[0]?.payload || [])).toEqual([1, 2, 3])
    })

    it("parses multiple frames", () => {
      const payload1 = new Uint8Array([1, 2])
      const payload2 = new Uint8Array([3, 4])
      const framed = concat(frameEnvelope(payload1, 0x00), frameEnvelope(payload2, 0x00))
      const frames = parseConnectFrames(framed)
      expect(frames.length).toBe(2)
    })

    it("handles empty input", () => {
      const frames = parseConnectFrames(new Uint8Array([]))
      expect(frames).toEqual([])
    })
  })

  describe("decodeUserJwtResponse", () => {
    it("decodes JWT from field 1", () => {
      const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test.signature"
      const encoded = encodeString(1, jwt)
      const result = decodeUserJwtResponse(encoded)
      expect(result).toBe(jwt)
    })

    it("returns null when field 1 is missing", () => {
      const encoded = encodeString(2, "other field")
      const result = decodeUserJwtResponse(encoded)
      expect(result).toBeNull()
    })

    it("returns null for empty buffer", () => {
      const result = decodeUserJwtResponse(new Uint8Array([]))
      expect(result).toBeNull()
    })
  })
})