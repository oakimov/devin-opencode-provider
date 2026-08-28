import type { LanguageModelV3Usage } from "@ai-sdk/provider"

export type DevinUsageCounters = {
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
}

export function buildLanguageModelV3UsageFromCounters(counters: DevinUsageCounters): LanguageModelV3Usage {
  // Like cursor's LoggableUsage (#7 + checkpoint token_details), Devin's #7 ModelUsageStats
  // reports aggregate input/output/cacheRead over the held Run. Server may report
  // cacheRead > input on some turns (verified: input=304 cacheRead=86720) — that's a
  // snapshot of cached context, not a partition of input. Clamping to input hid it.
  // Expose the raw server snapshot as total/cacheRead, and emit a debug trace so
  // consumers can diagnose warm-vs-cold cache correctly. Never derive noCache from
  // an invalid clamp — when cacheRead > input, report the raw values and let the
  // caller compare against the prior turn's checkpoint.
  const input = Math.max(0, counters.inputTokens)
  const output = Math.max(0, counters.outputTokens)
  const cacheReadRaw = Math.max(0, counters.cacheRead)
  const cacheWriteRaw = Math.max(0, counters.cacheWrite)
  const cacheRead = cacheReadRaw
  const cacheWrite = cacheWriteRaw
  // noCache is only meaningful when the server's snapshot is a valid partition;
  // otherwise we still emit raw values so debug logs show the real server numbers.
  const noCache: number | undefined = cacheReadRaw <= input ? Math.max(0, input - cacheReadRaw - cacheWriteRaw) : undefined
  return {
    inputTokens: {
      total: input,
      noCache,
      cacheRead,
      cacheWrite,
    },
    outputTokens: {
      total: output,
      text: output,
      reasoning: undefined,
    },
  }
}

export function emptyLanguageModelV3Usage(): LanguageModelV3Usage {
  return buildLanguageModelV3UsageFromCounters({
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
  })
}
