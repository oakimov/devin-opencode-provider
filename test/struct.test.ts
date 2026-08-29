import { describe, it, expect } from "bun:test"
import { encodeVarint, encodeString, concat, iterFields } from "../src/protocol/wire.js"

describe("wire struct handling", () => {
  it("encodes and decodes nested struct-like fields", () => {
    const inner = concat(encodeString(1, "key"), encodeString(2, "value"))
    const outer = concat(encodeString(1, "outer"), inner)
    const fields = iterFields(outer)
    expect(fields.length).toBeGreaterThan(0)
  })

  it("handles repeated fields", () => {
    const fields = [encodeString(1, "a"), encodeString(1, "b"), encodeString(1, "c")]
    const combined = concat(...fields)
    const parsed = iterFields(combined)
    expect(parsed.filter(f => f.num === 1).length).toBe(3)
  })

  it("handles varint and string mixed", () => {
    const mixed = concat(encodeString(1, "text"), concat(encodeString(2, "more"), encodeString(3, "even more")))
    const fields = iterFields(mixed)
    expect(fields.length).toBe(3)
  })

  it("handles large strings", () => {
    const large = "x".repeat(10000)
    const enc = encodeString(1, large)
    const fields = iterFields(enc)
    expect(new TextDecoder().decode(fields[0].value as Uint8Array).length).toBe(10000)
  })

  it("handles empty and whitespace strings", () => {
    for (const s of ["", " ", "  \n\t  "]) {
      const enc = encodeString(1, s)
      const fields = iterFields(enc)
      expect(new TextDecoder().decode(fields[0].value as Uint8Array)).toBe(s)
    }
  })
})
