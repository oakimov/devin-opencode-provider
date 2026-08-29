import { describe, it, expect } from "bun:test"
import { getDocumentedDevinModelContext, resolveDevinModelSupportsImages } from "../src/model-metadata.js"

describe("getDocumentedDevinModelContext", () => {
  it("returns undefined for unknown model", () => {
    expect(getDocumentedDevinModelContext("unknown-xyz-123")).toBeUndefined()
  })

  it("returns copy, not reference", () => {
    const a = getDocumentedDevinModelContext("unknown-xyz-123")
    expect(a).toBeUndefined()
  })

  it("handles empty id", () => {
    expect(getDocumentedDevinModelContext("")).toBeUndefined()
  })
})

describe("resolveDevinModelSupportsImages", () => {
  it("returns explicit true/false when provided", () => {
    expect(resolveDevinModelSupportsImages("any", true)).toBe(true)
    expect(resolveDevinModelSupportsImages("any", false)).toBe(false)
  })

  it("falls back to documented capabilities when undefined", () => {
    // unknown model with no documented caps -> false
    expect(resolveDevinModelSupportsImages("unknown-xyz", undefined)).toBe(false)
  })

  it("prefers explicit value over documented", () => {
    // even if documented would be true, explicit false wins
    expect(resolveDevinModelSupportsImages("claude-opus-5", false)).toBe(false)
    expect(resolveDevinModelSupportsImages("claude-opus-5", true)).toBe(true)
  })

  it("returns boolean", () => {
    expect(typeof resolveDevinModelSupportsImages("x", undefined)).toBe("boolean")
  })
})
