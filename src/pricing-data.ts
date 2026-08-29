/**
 * Devin model pricing / context / capabilities data.
 * 
 * This file contains pricing data for Devin models. The data structure follows
 * the OpenCode model cost format and is used for cost tracking and reporting.
 * 
 * The data is organized by base model IDs (effort/speed variants are handled
 * separately in the model config). Context tiers (-1m) are separate entries.
 * 
 * PRICING DATA STRUCTURE:
 * =======================
 * Each model entry contains:
 * - input: cost per 1M input tokens
 * - output: cost per 1M output tokens  
 * - cache_read: cost per 1M cached tokens read (optional)
 * - cache_write: cost per 1M cached tokens written (optional)
 * - context_over_200k: pricing for long context variants (optional)
 * 
 * DATA SOURCES:
 * =============
 * Currently stubbed with empty data. When Devin publishes official pricing,
 * this should be populated from:
 * - Devin's official pricing page
 * - Devin API documentation
 * - Devin's billing API responses
 * 
 * To generate this data programmatically, create a script that:
 * 1. Fetches pricing from Devin's billing API or documentation
 * 2. Normalizes the data to this structure
 * 3. Writes to this file
 * 
 * EXAMPLE STRUCTURE:
 * ==================
 * export const DEVIN_MODEL_COSTS = {
 *   "claude-opus-5": {
 *     input: 15.0,
 *     output: 75.0,
 *     cache_read: 1.5,
 *     cache_write: 3.0,
 *     context_over_200k: {
 *       input: 30.0,
 *       output: 150.0,
 *       cache_read: 3.0,
 *       cache_write: 6.0,
 *     }
 *   },
 *   "swe-1-7": {
 *     input: 10.0,
 *     output: 40.0,
 *     cache_read: 1.0,
 *     cache_write: 2.0,
 *   }
 * } as const
 */

export const DEVIN_PRICING_SOURCE = "" as const
export const DEVIN_CONTEXT_SOURCE = "" as const

export const DEVIN_MODEL_COSTS = {
  // Example structure - populate with real Devin pricing when available
  // "claude-opus-5": {
  //   input: 15.0,
  //   output: 75.0,
  //   cache_read: 1.5,
  //   cache_write: 3.0,
  // },
} as const

export const DEVIN_MODEL_CONTEXTS: Record<string, { maxContext?: number; maxContextForMaxMode?: number }> = {
  // Example context limits - populate with real Devin context data when available
  // "claude-opus-5": {
  //   maxContext: 200000,
  //   maxContextForMaxMode: 200000,
  // },
  // "claude-opus-5-1m": {
  //   maxContext: 1000000,
  // },
}

export const DEVIN_MODEL_CAPABILITIES: Record<string, { supportsImages: boolean }> = {
  // Example capabilities - populate with real Devin capability data when available
  // "claude-opus-5": {
  //   supportsImages: true,
  // },
  // "swe-1-7": {
  //   supportsImages: false,
  // },
}