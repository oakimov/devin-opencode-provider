/**
 * Devin model pricing / context / capabilities — stub until a real
 * `scripts/generate-devin-pricing.ts` exists (mirror of cursor's
 * `src/pricing-data.ts`).  The registry stays empty so no cost is
 * reported until rates are known; context/capabilities default to
 * conservative values via `model-metadata.ts` fallback.
 */

export const DEVIN_PRICING_SOURCE = "" as const
export const DEVIN_CONTEXT_SOURCE = "" as const

export const DEVIN_MODEL_COSTS = {} as const

export const DEVIN_MODEL_CONTEXTS: Record<string, { maxContext?: number; maxContextForMaxMode?: number }> = {}

export const DEVIN_MODEL_CAPABILITIES: Record<string, { supportsImages: boolean }> = {}
