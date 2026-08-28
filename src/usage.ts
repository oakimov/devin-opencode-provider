import type { LanguageModelV3Usage } from "@ai-sdk/provider"

export type DevinUsageCounters = {
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
}

export function buildLanguageModelV3UsageFromCounters(counters: DevinUsageCounters): LanguageModelV3Usage {
  const input = Math.max(0, counters.inputTokens)
  const output = Math.max(0, counters.outputTokens)
  const cacheRead = Math.min(Math.max(0, counters.cacheRead), input)
  const cacheWrite = Math.min(Math.max(0, counters.cacheWrite), input - cacheRead)
  const noCache = Math.max(0, input - cacheRead - cacheWrite)
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
