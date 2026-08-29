import { describe, it, expect } from "bun:test"
import { buildLanguageModelV3UsageFromCounters, emptyLanguageModelV3Usage } from "../src/usage.js"

describe("emptyLanguageModelV3Usage", () => {
  it("has zero totals", () => {
    const u = emptyLanguageModelV3Usage()
    expect(u.inputTokens.total).toBe(0)
    expect(u.outputTokens.total).toBe(0)
  })
})

describe("buildLanguageModelV3UsageFromCounters", () => {
  it("maps input/output/cache fields", () => {
    const u = buildLanguageModelV3UsageFromCounters({ inputTokens: 100, outputTokens: 50, cacheRead: 10, cacheWrite: 5 })
    expect(u.inputTokens.total).toBe(100)
    expect(u.outputTokens.total).toBe(50)
    // cache fields are present when provided
    expect(u.inputTokens.cacheRead).toBeDefined()
  })

  it("clamps negative to zero", () => {
    const u = buildLanguageModelV3UsageFromCounters({ inputTokens: -5, outputTokens: -10, cacheRead: -1, cacheWrite: -1 })
    expect(u.inputTokens.total).toBe(0)
    expect(u.outputTokens.total).toBe(0)
  })

  it("handles zero counters", () => {
    const u = buildLanguageModelV3UsageFromCounters({ inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 })
    expect(u.inputTokens.total).toBe(0)
    expect(u.outputTokens.total).toBe(0)
  })

  it("handles large token counts", () => {
    const u = buildLanguageModelV3UsageFromCounters({ inputTokens: 1_000_000, outputTokens: 500_000, cacheRead: 900_000, cacheWrite: 10_000 })
    expect(u.inputTokens.total).toBe(1_000_000)
    expect(u.outputTokens.total).toBe(500_000)
  })

  it("does not require cache fields to produce usage", () => {
    const u = buildLanguageModelV3UsageFromCounters({ inputTokens: 10, outputTokens: 20, cacheRead: 0, cacheWrite: 0 })
    expect(u.inputTokens.total).toBe(10)
    expect(u.outputTokens.total).toBe(20)
  })
})
