import { describe, it, expect } from "bun:test"
import { buildMetadata } from "../src/protocol/metadata.js"
import { iterFields } from "../src/protocol/wire.js"

describe("buildMetadata", () => {
  it("encodes required fields", () => {
    const meta = buildMetadata({ apiKey: "test-key", userJwt: "jwt.123" })
    const fields = iterFields(meta)
    const nums = fields.map(f => f.num)
    expect(nums).toContain(1) // app
    expect(nums).toContain(2) // extension version
    expect(nums).toContain(3) // apiKey
    expect(nums).toContain(7) // ide version
  })

  it("uses defaults for versions when not provided", () => {
    const meta = buildMetadata({ apiKey: "k" })
    const text = new TextDecoder().decode(meta)
    expect(text).toContain("1.48.2")
    expect(text).toContain("3.6.27")
  })

  it("respects overridden versions", () => {
    const meta = buildMetadata({ apiKey: "k", extensionVersion: "9.9.9", ideVersion: "8.8.8" })
    const text = new TextDecoder().decode(meta)
    expect(text).toContain("9.9.9")
    expect(text).toContain("8.8.8")
  })

  it("includes provided session and request ids", () => {
    const sid = "sess-123"
    const meta = buildMetadata({ apiKey: "k", sessionId: sid, requestId: 42n })
    const text = new TextDecoder().decode(meta)
    expect(text).toContain(sid)
  })

  it("produces different bytes for different apiKeys", () => {
    const a = buildMetadata({ apiKey: "key-a" })
    const b = buildMetadata({ apiKey: "key-b" })
    expect(a).not.toEqual(b)
  })

  it("encodes platform and locale consistently", () => {
    const meta = buildMetadata({ apiKey: "k" })
    const text = new TextDecoder().decode(meta)
    expect(text).toContain("mac")
    expect(text).toContain("windsurf")
  })

  it("generates unique requestIds when not provided", () => {
    const a = buildMetadata({ apiKey: "k" })
    const b = buildMetadata({ apiKey: "k" })
    expect(a).not.toEqual(b)
  })
})
