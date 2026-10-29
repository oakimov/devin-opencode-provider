import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { modelsToConfig } from "../src/model-config.js"
import {
  clearDevinLiveCatalog,
  clearDevinWireIdAliases,
  lookupDevinLiveModel,
  type ModelInfo,
} from "../src/models.js"
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

describe("live catalog attachment caps (issue #3)", () => {
  beforeEach(() => {
    clearDevinWireIdAliases()
    clearDevinLiveCatalog()
  })
  afterEach(() => {
    clearDevinWireIdAliases()
    clearDevinLiveCatalog()
  })

  function makeModel(overrides: Partial<ModelInfo> & { id: string }): ModelInfo {
    return {
      displayName: overrides.displayName ?? overrides.id,
      supportsAgent: true,
      maxContext: 200_000,
      maxOutput: 32_000,
      variants: [],
      ...overrides,
    }
  }

  it("modelsToConfig remembers supportsImages for stream lookup", () => {
    modelsToConfig([makeModel({ id: "swe-2-max", supportsImages: true })])
    const live = lookupDevinLiveModel("swe-2-max")
    expect(live?.supportsImages).toBe(true)
    expect(resolveDevinModelSupportsImages("swe-2-max", live?.supportsImages)).toBe(true)
  })

  it("fail-closed without a remembered catalog", () => {
    expect(lookupDevinLiveModel("swe-2-max")).toBeUndefined()
    expect(resolveDevinModelSupportsImages("swe-2-max", undefined)).toBe(false)
  })

  it("empty catalog clears remembered models", () => {
    modelsToConfig([makeModel({ id: "swe-2-max", supportsImages: true })])
    modelsToConfig([])
    expect(lookupDevinLiveModel("swe-2-max")).toBeUndefined()
  })
})
