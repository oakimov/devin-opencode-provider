/**
 * Devin model token pricing for OpenCode cost reporting.
 * Mirrors `cursor-opencode-provider/src/pricing.ts` but uses `DEVIN_MODEL_COSTS`.
 * Rates come from Devin's public docs when available; generated data lives in
 * `pricing-data.ts`. Unknown models get no `cost`.
 */
import { DEVIN_MODEL_COSTS } from "./pricing-data.js"

export type OpenCodeModelCost = {
  input: number
  output: number
  cache_read?: number
  cache_write?: number
  context_over_200k?: OpenCodeModelCost
}

export type OpenCode2ModelCost = {
  tier?: { type: "context"; size: number }
  input: number
  output: number
  cache: { read: number; write: number }
}

export type DevinPricingCoverage = { priced: string[]; missing: string[] }

export const DEVIN_UNPRICED_MODEL_IDS = [] as const
const UNPRICED = new Set<string>(DEVIN_UNPRICED_MODEL_IDS)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}
function collectCostValidationErrors(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) { errors.push(`${path} must be an object`); return }
  if (!isNonNegativeFiniteNumber(value.input)) errors.push(`${path}.input must be a non-negative finite number`)
  if (!isNonNegativeFiniteNumber(value.output)) errors.push(`${path}.output must be a non-negative finite number`)
  if (value.cache_read !== undefined && !isNonNegativeFiniteNumber(value.cache_read)) errors.push(`${path}.cache_read must be a non-negative finite number`)
  if (value.cache_write !== undefined && !isNonNegativeFiniteNumber(value.cache_write)) errors.push(`${path}.cache_write must be a non-negative finite number`)
  if (value.context_over_200k !== undefined) collectCostValidationErrors(value.context_over_200k, `${path}.context_over_200k`, errors)
}
export function validateOpenCodeModelCost(value: unknown, path = "cost"): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  collectCostValidationErrors(value, path, errors)
  return { valid: errors.length === 0, errors }
}
export function isOpenCodeModelCost(value: unknown): value is OpenCodeModelCost {
  return validateOpenCodeModelCost(value).valid
}
export function wireModelIdForPricing(modelId: string): { baseId: string; longContextEntry: boolean } {
  const match = /^(.*)-1m(?:-(\d+))?$/.exec(modelId)
  if (!match) return { baseId: modelId, longContextEntry: false }
  return { baseId: match[1]!, longContextEntry: true }
}
function asMutableCost(value: OpenCodeModelCost): OpenCodeModelCost {
  const copy: OpenCodeModelCost = { input: value.input, output: value.output }
  if (value.cache_read !== undefined) copy.cache_read = value.cache_read
  if (value.cache_write !== undefined) copy.cache_write = value.cache_write
  if (value.context_over_200k) copy.context_over_200k = asMutableCost(value.context_over_200k)
  return copy
}
export function getDevinModelCost(modelId: string): OpenCodeModelCost | undefined {
  const { baseId } = wireModelIdForPricing(modelId)
  const found = (DEVIN_MODEL_COSTS as Record<string, OpenCodeModelCost>)[baseId]
  if (!found) return undefined
  return asMutableCost(found)
}
export function applyDevinModelCost<T extends Record<string, unknown>>(modelId: string, entry: T): T & { cost?: OpenCodeModelCost } {
  const modelCost = getDevinModelCost(modelId)
  if (!modelCost) return entry
  return { ...entry, cost: modelCost }
}
export function toOpenCode2Costs(cost: OpenCodeModelCost | undefined): OpenCode2ModelCost[] {
  if (!cost) return []
  const out: OpenCode2ModelCost[] = [{ input: cost.input, output: cost.output, cache: { read: cost.cache_read ?? 0, write: cost.cache_write ?? 0 } }]
  if (cost.context_over_200k) out.push({ tier: { type: "context", size: 200_000 }, input: cost.context_over_200k.input, output: cost.context_over_200k.output, cache: { read: cost.context_over_200k.cache_read ?? 0, write: cost.context_over_200k.cache_write ?? 0 } })
  return out
}
export function checkDevinPricingCoverage(modelIds: string[]): DevinPricingCoverage {
  const priced: string[] = []
  const missing: string[] = []
  for (const modelId of modelIds) {
    const { baseId } = wireModelIdForPricing(modelId)
    if (UNPRICED.has(baseId) || getDevinModelCost(modelId)) priced.push(modelId)
    else missing.push(modelId)
  }
  return { priced, missing }
}
