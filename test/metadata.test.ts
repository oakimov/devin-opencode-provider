import { describe, it, expect, afterEach } from "bun:test"
import {
  buildCliMetadata,
  buildDiscoveryMetadata,
  buildMetadata,
  buildWindsurfMetadata,
  DISCOVERY_DISPLAY_SLOTS,
  normalizeSessionToken,
  resolveClientIdentity,
  SESSION_TOKEN_PREFIX,
} from "../src/protocol/metadata.js"
import { iterFields } from "../src/protocol/wire.js"

const savedIdentity = process.env.DEVIN_CLIENT_IDENTITY

afterEach(() => {
  if (savedIdentity === undefined) delete process.env.DEVIN_CLIENT_IDENTITY
  else process.env.DEVIN_CLIENT_IDENTITY = savedIdentity
})

function strings(buf: Uint8Array, num: number): string[] {
  const out: string[] = []
  for (const field of iterFields(buf)) {
    if (field.num === num && field.wire === 2 && field.value instanceof Uint8Array) {
      out.push(new TextDecoder().decode(field.value))
    }
  }
  return out
}

function varints(buf: Uint8Array, num: number): number[] {
  const out: number[] = []
  for (const field of iterFields(buf)) {
    if (field.num === num && field.wire === 0) out.push(Number(field.value))
  }
  return out
}

describe("buildMetadata", () => {
  it("defaults to the released Devin CLI identity", () => {
    delete process.env.DEVIN_CLIENT_IDENTITY
    expect(resolveClientIdentity()).toBe("cli")
    const meta = buildMetadata({ apiKey: "test-key", userJwt: "jwt.123", sessionId: "sess", requestId: 7n, triggerId: "trig" })
    expect(strings(meta, 1)).toEqual(["devin-cli"])
    expect(strings(meta, 2)).toEqual(["3000.6.2"])
    expect(strings(meta, 7)).toEqual(["3000.6.2"])
    expect(strings(meta, 12)).toEqual(["chisel"])
    expect(strings(meta, 28)).toEqual(["chisel"])
    expect(strings(meta, 3)).toEqual([`${SESSION_TOKEN_PREFIX}test-key`])
    expect(strings(meta, 21)).toEqual(["jwt.123"])
    expect(strings(meta, 5)[0]).not.toBe("mac")
    expect(strings(meta, 17)).toEqual([])
  })

  it("keeps the Windsurf desktop identity behind the rollback flag", () => {
    const meta = buildWindsurfMetadata({ apiKey: "k", userJwt: "jwt.123", sessionId: "sess-123", requestId: 42n })
    expect(strings(meta, 1)).toEqual(["windsurf"])
    expect(strings(meta, 2)).toEqual(["1.48.2"])
    expect(strings(meta, 7)).toEqual(["3.6.27"])
    expect(strings(meta, 5)).toEqual(["mac"])
    expect(strings(meta, 28)).toEqual(["windsurf"])
    expect(strings(meta, 21)).toEqual(["jwt.123"])
    expect(strings(meta, 3)).toEqual([`${SESSION_TOKEN_PREFIX}k`])
    expect(strings(meta, 10)).toEqual(["sess-123"])
    expect(varints(meta, 9)).toEqual([42])
    expect(strings(meta, 17)[0]).toContain("windsurf")
  })

  it("respects overridden versions", () => {
    const meta = buildMetadata({ apiKey: "k", identity: "cli", extensionVersion: "9.9.9", ideVersion: "8.8.8" })
    expect(strings(meta, 2)).toEqual(["9.9.9"])
    expect(strings(meta, 7)).toEqual(["8.8.8"])
  })

  it("produces different bytes for different apiKeys", () => {
    const a = buildMetadata({ apiKey: "key-a", identity: "cli", sessionId: "s", requestId: 1n, triggerId: "t" })
    const b = buildMetadata({ apiKey: "key-b", identity: "cli", sessionId: "s", requestId: 1n, triggerId: "t" })
    expect(a).not.toEqual(b)
  })

  it("switches identity from the environment", () => {
    process.env.DEVIN_CLIENT_IDENTITY = "windsurf"
    expect(resolveClientIdentity()).toBe("windsurf")
    expect(strings(buildMetadata({ apiKey: "k" }), 1)).toEqual(["windsurf"])
    process.env.DEVIN_CLIENT_IDENTITY = "cli"
    expect(strings(buildMetadata({ apiKey: "k" }), 1)).toEqual(["devin-cli"])
  })
})

describe("discovery metadata", () => {
  it("announces the chisel dev channel and native display slots", () => {
    const meta = buildDiscoveryMetadata({ apiKey: "k", sessionId: "s", requestId: 1n, triggerId: "t" })
    expect(strings(meta, 1)).toEqual(["chisel"])
    expect(strings(meta, 2)).toEqual(["0.0.0-dev"])
    expect(strings(meta, 7)).toEqual(["0.0.0-dev"])
    expect(strings(meta, 12)).toEqual(["chisel"])
    expect(strings(meta, 28)).toEqual([])
    expect(varints(meta, 30)).toEqual([...DISCOVERY_DISPLAY_SLOTS])
    expect(strings(meta, 21)).toEqual([])
  })
})

describe("normalizeSessionToken", () => {
  it("adds the CLI scheme prefix once", () => {
    expect(normalizeSessionToken("abc")).toBe("devin-session-token$abc")
    expect(normalizeSessionToken("devin-session-token$abc")).toBe("devin-session-token$abc")
    expect(normalizeSessionToken("")).toBe("")
    const meta = buildCliMetadata({ apiKey: "devin-session-token$already", sessionId: "s", requestId: 1n, triggerId: "t" })
    expect(strings(meta, 3)).toEqual(["devin-session-token$already"])
  })
})
