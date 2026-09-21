import { describe, it, expect } from "bun:test"
import {
  buildLanguageModelV3UsageFromCounters,
  emptyLanguageModelV3Usage,
  formatDevinCacheDiagnostics,
  formatTurnUsageValidation,
} from "../src/usage.js"

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
    const u = buildLanguageModelV3UsageFromCounters({
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheRead: 900_000,
      cacheWrite: 10_000,
    })
    expect(u.inputTokens.total).toBe(1_000_000)
    expect(u.outputTokens.total).toBe(500_000)
  })

  it("does not require cache fields to produce usage", () => {
    const u = buildLanguageModelV3UsageFromCounters({
      inputTokens: 10,
      outputTokens: 20,
      cacheRead: 0,
      cacheWrite: 0,
    })
    expect(u.inputTokens.total).toBe(10)
    expect(u.outputTokens.total).toBe(20)
  })
})

describe("formatTurnUsageValidation", () => {
  it("emits ok status when totals match", () => {
    const counters = { inputTokens: 100, outputTokens: 20, cacheRead: 40, cacheWrite: 10 }
    const usage = buildLanguageModelV3UsageFromCounters(counters)
    const line = formatTurnUsageValidation(counters, usage)
    expect(line.startsWith("turn usage validation:")).toBe(true)
    expect(line).toContain("status=ok")
    expect(line).toContain("source=devin-model-usage")
  })

  it("emits ok for cacheRead>input snapshot when totals still match", () => {
    const counters = { inputTokens: 304, outputTokens: 12, cacheRead: 86720, cacheWrite: 0 }
    const usage = buildLanguageModelV3UsageFromCounters(counters)
    const line = formatTurnUsageValidation(counters, usage)
    expect(line).toContain("status=ok")
    expect(line).toContain("rawCachedRatio=n/a")
  })
})

describe("formatDevinCacheDiagnostics", () => {
  it("emits Devin wire fields and omits RequestContext costume", () => {
    const line = formatDevinCacheDiagnostics(
      { inputTokens: 100, outputTokens: 10, cacheRead: 80, cacheWrite: 0 },
      {
        sessionKeyHash: "sessionhash",
        cascadeIdHash: "cascadehash",
        promptCacheKeyHash: "cachehash",
        modelId: "swe-1-6",
        prefixHash: "abcdef0123456789ffff",
        systemPromptHash: "fedcba9876543210aaaa",
        systemPromptSent: true,
        displayToolCalls: 3,
      },
    )
    expect(line.startsWith("cache diagnosis:")).toBe(true)
    expect(line).toContain("continuity=cold")
    expect(line).toContain("cascadeIdHash=cascadehash")
    expect(line).not.toContain("ses_test")
    expect(line).toContain("perModelCallCache=unavailable")
    expect(line).toContain("prefixHash=abcdef0123456789")
    expect(line).toContain("rawReadRatio=80.0%")
    expect(line).not.toContain("requestContext")
    expect(line).not.toContain("checkpointUpdates")
    expect(line).not.toContain("execRequests")
    expect(line).not.toContain("reconstructedHit=")
  })

  it("marks continuity=warm and does not invent 100% when cacheRead > input", () => {
    const line = formatDevinCacheDiagnostics(
      { inputTokens: 50, outputTokens: 5, cacheRead: 120, cacheWrite: 0 },
      {
        cascadeIdHash: "cascadehash2",
        prior: { inputTokens: 100, outputTokens: 10, cacheRead: 0, cacheWrite: 0 },
        prefixHash: "1111222233334444aaaa",
        systemPromptSent: true,
        displayToolCalls: 0,
      },
    )
    expect(line).toContain("continuity=warm")
    expect(line).toContain("rawReadRatio=n/a")
    expect(line).toContain("rawUncached=n/a")
    expect(line).toContain("reconstructedHit=70.6%")
  })

  it("does not double-count cacheRead when it is an input partition", () => {
    const line = formatDevinCacheDiagnostics(
      { inputTokens: 120, outputTokens: 5, cacheRead: 80, cacheWrite: 0 },
      {
        cascadeIdHash: "partitionhash",
        prior: { inputTokens: 100, outputTokens: 10, cacheRead: 40, cacheWrite: 0 },
        prefixHash: "1111222233334444aaaa",
        systemPromptSent: true,
        displayToolCalls: 0,
      },
    )
    expect(line).toContain("priorContext=100")
    expect(line).toContain("currentContext=120")
    expect(line).toContain("contextDelta=20")
    expect(line).toContain("rawReadVsPriorContext=80.0%")
  })
})
