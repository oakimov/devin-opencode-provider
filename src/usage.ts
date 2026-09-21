import type { LanguageModelV3Usage } from "@ai-sdk/provider"

export type DevinUsageCounters = {
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
}

export type DevinCacheDiagnosticStats = {
  sessionKeyHash?: string
  cascadeIdHash: string
  promptCacheKeyHash?: string
  modelId?: string
  /** Prior turn for this session (undefined → cold). */
  prior?: DevinUsageCounters
  /** Hash of advertised tools + system prompt + compaction flag. */
  prefixHash: string
  systemPromptHash?: string
  systemPromptSent: boolean
  displayToolCalls: number
}

function usageRatio(part: number, whole: number): string {
  if (!(whole > 0)) return "n/a"
  return `${((100 * Math.max(0, part)) / whole).toFixed(1)}%`
}

function usageCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

function diagnosticContextTokens(counters: DevinUsageCounters): number {
  const input = Math.max(0, Math.trunc(counters.inputTokens))
  const cacheRead = Math.max(0, Math.trunc(counters.cacheRead))
  // Some Devin frames report cacheRead as a separate cumulative context
  // snapshot (> input); ordinary frames report it as an input partition.
  return input + (cacheRead > input ? cacheRead : 0)
}

/**
 * Per-request cache line from Devin ModelUsageStats. `perModelCallCache` is
 * unavailable because Devin exposes no such API.
 */
export function formatDevinCacheDiagnostics(
  counters: DevinUsageCounters,
  stats: DevinCacheDiagnosticStats,
): string {
  const rawInput = Math.max(0, Math.trunc(counters.inputTokens))
  const rawRead = Math.max(0, Math.trunc(counters.cacheRead))
  const rawWrite = Math.max(0, Math.trunc(counters.cacheWrite))
  const partitionOk = rawRead <= rawInput
  const rawUncached = partitionOk
    ? Math.max(0, rawInput - Math.min(rawRead, rawInput) - Math.min(rawWrite, rawInput))
    : undefined
  const prior = stats.prior
  const continuity =
    prior && (rawRead > 0 || (prior.inputTokens > 0 && rawRead >= prior.inputTokens * 0.5))
      ? "warm"
      : "cold"
  const priorContext = prior ? diagnosticContextTokens(prior) : undefined
  const currentContext = diagnosticContextTokens(counters)
  const fields = [
    "cache diagnosis:",
    `sessionKeyHash=${stats.sessionKeyHash ?? "-"}`,
    `cascadeIdHash=${stats.cascadeIdHash}`,
    `promptCacheKeyHash=${stats.promptCacheKeyHash ?? "-"}`,
    `model=${stats.modelId ?? "-"}`,
    `continuity=${continuity}`,
    `rawInput=${rawInput}`,
    `rawCacheRead=${rawRead}`,
    `rawCacheWrite=${rawWrite}`,
    `rawUncached=${rawUncached ?? "n/a"}`,
    `rawReadRatio=${partitionOk ? usageRatio(rawRead, rawInput) : "n/a"}`,
    `rawWriteRatio=${usageRatio(rawWrite, rawInput)}`,
    `priorContext=${priorContext ?? "unavailable"}`,
    `currentContext=${currentContext}`,
    `contextDelta=${priorContext !== undefined ? currentContext - priorContext : "unavailable"}`,
    `rawReadVsPriorContext=${priorContext !== undefined ? usageRatio(rawRead, priorContext) : "n/a"}`,
  ]
  if (!partitionOk) {
    fields.push(`reconstructedHit=${usageRatio(rawRead, rawRead + rawInput)}`)
  }
  fields.push(
    `prefixHash=${stats.prefixHash.slice(0, 16)}`,
    `systemPromptHash=${stats.systemPromptHash?.slice(0, 16) ?? "none"}`,
    `systemPromptSent=${stats.systemPromptSent}`,
    `displayToolCalls=${stats.displayToolCalls}`,
    "perModelCallCache=unavailable",
  )
  return fields.join(" ")
}

/**
 * Turn-usage line. Status is `ok` when AI SDK totals match the raw counters
 * (and input parts sum when cacheRead is a partition of input).
 */
export function formatTurnUsageValidation(
  counters: DevinUsageCounters,
  usage: LanguageModelV3Usage,
): string {
  const input = usageCount(usage.inputTokens?.total)
  const noCache = usageCount(usage.inputTokens?.noCache)
  const cacheRead = usageCount(usage.inputTokens?.cacheRead)
  const cacheWrite = usageCount(usage.inputTokens?.cacheWrite)
  const partitionOk = counters.cacheRead <= counters.inputTokens
  const inputParts = partitionOk ? noCache + cacheRead + cacheWrite : input
  const output = usageCount(usage.outputTokens?.total)
  const text = usageCount(usage.outputTokens?.text)
  const reasoning = usageCount(usage.outputTokens?.reasoning)
  const outputParts = reasoning > 0 ? text + reasoning : output
  const sentTotal = input + output
  const rawTotal = counters.inputTokens + counters.outputTokens
  const inputMatch = partitionOk ? input === inputParts : input === counters.inputTokens
  const outputMatch = output === counters.outputTokens
  const totalMatch = sentTotal === rawTotal
  const status = inputMatch && outputMatch && totalMatch ? "ok" : "mismatch"

  return [
    "turn usage validation:",
    `status=${status}`,
    `source=devin-model-usage`,
    `rawTotal=${rawTotal}`,
    `sentTotal=${sentTotal}`,
    `totalMatch=${totalMatch}`,
    `input=${input}`,
    `inputParts=${inputParts}`,
    `inputMatch=${inputMatch}`,
    `output=${output}`,
    `outputParts=${outputParts}`,
    `outputMatch=${outputMatch}`,
    `opencodeProjectedTotal=${inputParts + outputParts}`,
    `opencodeMatch=${inputParts + outputParts === sentTotal}`,
    `rawCachedRatio=${partitionOk ? usageRatio(counters.cacheRead + counters.cacheWrite, counters.inputTokens) : "n/a"}`,
    `sentCachedRatio=${partitionOk ? usageRatio(cacheRead + cacheWrite, input) : "n/a"}`,
  ].join(" ")
}

export function buildLanguageModelV3UsageFromCounters(counters: DevinUsageCounters): LanguageModelV3Usage {
  // Devin's #7 ModelUsageStats reports aggregate input/output/cacheRead over
  // the held Run. Server may report
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
