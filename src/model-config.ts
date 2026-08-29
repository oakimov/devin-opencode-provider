import {
  DEVIN_VARIANT_PARAMETERS_KEY,
  clearDevinWireIdAliases,
  registerDevinWireIdAlias,
  type ModelInfo,
  type ModelVariant,
} from "./models.js"
import { applyDevinModelCost } from "./pricing.js"
import {
  getDocumentedDevinModelContext,
  resolveDevinModelSupportsImages,
} from "./model-metadata.js"

/**
 * Devin `ModelInfo` → OpenCode model-config mapping.
 *
 * Devin exposes flat `model_uid`s (`claude-opus-5-medium`, `…-low-fast`, …).
 * We collapse effort/speed/thinking suffixes into ONE OpenCode base id with
 * parameter-only variants (Cursor shape). The language model reconstructs the
 * wire uid from base + `devinVariantParameters` at request time — variants
 * must never carry a second model id or the catalog looks flat again.
 *
 * VARIANT MAPPING STRATEGY:
 * ========================
 * Devin's API returns many flat model IDs like:
 * - claude-opus-5-medium
 * - claude-opus-5-max-fast
 * - swe-1-7-lightning-medium
 * - MODEL_PRIVATE_2 (opaque Sonnet 4.5)
 *
 * These are grouped by "display-name-first" logic:
 * 1. If displayName exists (e.g. "Claude Opus 5 Low Fast"), peel variant phrases
 * 2. If displayName missing, fall back to id suffix stripping (e.g. "-low-fast")
 * 3. Group peeled base IDs together into one OpenCode model
 * 4. Create parameter-only variants for each effort/speed/thinking combo
 * 5. Register wire-id aliases for opaque IDs that can't be synthesized
 *
 * PARAMETER SYNTHESIS:
 * ===================
 * Each variant maps to `devinVariantParameters` array:
 * - effort: none|minimal|low|medium|high|xhigh|max
 * - fast: true/false (speed suffix)
 * - lightning: true/false (SWE Lightning models)
 * - thinking: true/false (reasoning mode)
 * - reasoning: true/false (alternative reasoning flag)
 * - priority: true/false (fast variant alternative)
 * - slow: true/false (slow variant)
 *
 * Example mapping:
 * - "Low Fast" → [{id: "effort", value: "low"}, {id: "fast", value: "true"}]
 * - "Lightning Max" → [{id: "lightning", value: "true"}, {id: "effort", value: "max"}]
 * - "No Thinking" → [{id: "thinking", value: "false"}]
 *
 * WIRE ID RECONSTRUCTION:
 * ======================
 * At request time, `wireModelIdFromBaseAndParams` reconstructs Devin's flat uid:
 * - Base: "claude-opus-5"
 * - Params: [{id: "effort", value: "low"}, {id: "fast", value: "true"}]
 * - Result: "claude-opus-5-low-fast"
 *
 * For opaque IDs (MODEL_PRIVATE_*), the alias table provides direct mapping.
 *
 * CONTEXT TIERS:
 * =============
 * Context tiers like "-1m" stay separate base models rather than Max Mode flags:
 * - claude-opus-4-6 (200K context)
 * - claude-opus-4-6-1m (1M context)
 * This mirrors Devin's model catalog structure.
 */

function stripMarkupTags(value: string): string {
  const chunks: string[] = []
  let cursor = 0
  while (cursor < value.length) {
    const start = value.indexOf("<", cursor)
    if (start === -1) {
      chunks.push(value.slice(cursor))
      break
    }
    chunks.push(value.slice(cursor, start))
    const end = value.indexOf(">", start + 1)
    if (end === -1) {
      chunks.push(value.slice(start))
      break
    }
    cursor = end + 1
  }
  return chunks.join("")
}

function safeLabel(value: string): string {
  return (
    stripMarkupTags(value)
      .replace(/[()<>&"'`]/g, "")
      .replace(/\s+/g, " ")
      .trim() || "default"
  )
}

function baseName(mi: ModelInfo): string {
  return safeLabel(mi.displayName ?? mi.id)
}

function modelInfoVariants(
  mi: ModelInfo,
  variants: ModelVariant[],
): Record<string, Record<string, unknown>> | undefined {
  if (variants.length === 0) return undefined
  const entries: Record<string, Record<string, unknown>> = {}
  const usedKeys = new Set<string>()
  const base = safeLabel(mi.displayName ?? mi.id)

  const tagDims = (p: { id: string; value: string }[]): string => {
    const labels: string[] = []
    for (const d of p) {
      if (d.id === "fast" && d.value === "true") labels.push("Fast")
      else if (d.id === "thinking" && d.value === "true") labels.push("Thinking")
      else if (d.id === "context") labels.push(d.value)
    }
    if (labels.length > 0) return ` ${labels.join(" ")}`
    if (p.length === 0) return ""
    return " default"
  }

  for (const v of variants) {
    const sanitized = safeLabel(v.displayName || v.key || "default")
    let key = sanitized
    if (key === base && !usedKeys.has(key)) {
      key = `${base}${tagDims(v.parameterValues)}` || `${base} default`
    } else if (usedKeys.has(key)) {
      key = `${sanitized}${tagDims(v.parameterValues)}`
    }
    let n = 2
    while (usedKeys.has(key)) key = `${sanitized}${tagDims(v.parameterValues)} ${n++}`
    usedKeys.add(key)

    entries[key] = {
      [DEVIN_VARIANT_PARAMETERS_KEY]: v.parameterValues.map((p) => ({ ...p })),
    }
  }
  return entries
}

export function thinkingSuffixBaseNames(models: ModelInfo[]): Set<string> {
  const flags = new Map<string, { hasThinking: boolean; hasNonThinking: boolean }>()
  for (const m of models) {
    const base = baseName(m)
    const entry = flags.get(base) ?? { hasThinking: false, hasNonThinking: false }
    if (m.supportsThinking) entry.hasThinking = true
    else entry.hasNonThinking = true
    flags.set(base, entry)
  }
  const ambiguous = new Set<string>()
  for (const [base, f] of flags) if (f.hasThinking && f.hasNonThinking) ambiguous.add(base)
  return ambiguous
}

export function modelInfoToConfig(
  mi: ModelInfo,
  options: { thinkingSuffix?: boolean } = {},
) {
  let name = baseName(mi)
  if (options.thinkingSuffix) name += " Thinking"
  const documentedContext = getDocumentedDevinModelContext(mi.id)
  const context = mi.maxContext ?? documentedContext?.maxContext ?? 200_000
  const output = mi.maxOutput ?? 32_000
  const supportsImages = resolveDevinModelSupportsImages(mi.id, mi.supportsImages)
  const config: Record<string, any> = {
    name,
    attachment: supportsImages,
    reasoning: mi.supportsThinking ?? false,
    tool_call: mi.supportsAgent ?? true,
    temperature: false,
    modalities: {
      input: supportsImages ? ["text", "image"] : ["text"],
      output: ["text"],
    },
    limit: {
      context,
      output,
    },
  }
  // Live RPC cost from GetCascadeModelConfigs #32 (Input/Cached/Output)
  if (mi.cost) {
    const liveCost: Record<string, unknown> = { input: mi.cost.input, output: mi.cost.output }
    if (mi.cost.cache_read !== undefined) liveCost.cache_read = mi.cost.cache_read
    if (mi.cost.cache_write !== undefined) liveCost.cache_write = mi.cost.cache_write
    config.cost = liveCost
  }
  const variantConfig = modelInfoVariants(mi, mi.variants)
  if (variantConfig) config.variants = variantConfig
  return config
}

/**
 * Grouping is display-name-first. Devin wire ids are often opaque
 * (`MODEL_PRIVATE_*`) or disagree with the label (`-priority` vs display
 * "Fast"). The label encodes the full variant stack
 * ("GPT-5.1 Low Thinking Fast"); we peel known trailing phrases to get a
 * shared base, and register wire-id aliases so request time still hits the
 * real uid. Id-suffix stripping is only a fallback when displayName is empty.
 */

/** Trailing display phrases that are variants, longest-first. */
const DISPLAY_VARIANT_PHRASES = [
  "no thinking",
  "x-high",
  "xhigh",
  "thinking",
  "lightning",
  "minimal",
  "reasoning",
  "priority",
  "fast",
  "slow",
  "none",
  "low",
  "medium",
  "high",
  "max",
] as const

/** Id suffixes kept as fallback when a model has no displayName. */
const DEVIN_VARIANT_SUFFIXES = [
  "-no-thinking-fast",
  "-xhigh-thinking-fast",
  "-high-thinking-fast",
  "-medium-thinking-fast",
  "-low-thinking-fast",
  "-max-thinking-fast",
  "-lightning-medium",
  "-lightning-max",
  "-no-thinking",
  "-xhigh-thinking",
  "-high-thinking",
  "-medium-thinking",
  "-low-thinking",
  "-max-thinking",
  "-thinking",
  "-none-priority",
  "-xhigh-priority",
  "-high-priority",
  "-medium-priority",
  "-low-priority",
  "-max-priority",
  "-xhigh-fast",
  "-high-fast",
  "-medium-fast",
  "-low-fast",
  "-max-fast",
  "-none",
  "-minimal",
  "-xhigh",
  "-high",
  "-medium",
  "-low",
  "-max",
  "-priority",
  "-fast",
  "-slow",
  "-lightning",
] as const

const DEVIN_CONTEXT_TIER_SUFFIXES = ["-1m"] as const

function peelContextTier(id: string): { stem: string; contextSuffix: string } {
  const lower = id.toLowerCase()
  for (const tier of DEVIN_CONTEXT_TIER_SUFFIXES) {
    if (lower.endsWith(tier)) {
      return { stem: id.slice(0, -tier.length), contextSuffix: id.slice(-tier.length) }
    }
    const underscored = tier.replace(/-/g, "_")
    if (underscored !== tier && lower.endsWith(underscored)) {
      return {
        stem: id.slice(0, -underscored.length),
        contextSuffix: id.slice(-underscored.length),
      }
    }
  }
  return { stem: id, contextSuffix: "" }
}

function variantNameFromSuffix(suffix: string): string {
  return suffix
    .slice(1)
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => {
      if (part.toLowerCase() === "xhigh") return "Xhigh"
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
    })
    .join(" ")
}

function slugifyModelLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function titleCaseVariantPhrase(phrase: string): string {
  if (/^x-?high$/i.test(phrase)) return "Xhigh"
  return phrase
    .split(/\s+/)
    .map((w) => {
      if (/^x-?high$/i.test(w)) return "Xhigh"
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
    })
    .join(" ")
}

/** Peel context tier + trailing variant phrases from a display label. */
function parseDisplayVariants(display: string): {
  baseLabel: string
  contextSuffix: string
  variantName: string | null
} {
  let n = safeLabel(display)
  let contextSuffix = ""
  const oneM = n.match(/\s+1M$/i)
  if (oneM) {
    contextSuffix = "-1m"
    n = n.slice(0, -oneM[0].length).trim()
  }
  const found: string[] = []
  let changed = true
  while (changed) {
    changed = false
    for (const phrase of DISPLAY_VARIANT_PHRASES) {
      const re = new RegExp(`\\s+${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+")}$`, "i")
      if (re.test(n)) {
        n = n.replace(re, "").trim()
        found.unshift(titleCaseVariantPhrase(phrase))
        changed = true
        break
      }
    }
  }
  return {
    baseLabel: n,
    contextSuffix,
    variantName: found.length > 0 ? found.join(" ") : null,
  }
}

function splitDevinVariant(model: ModelInfo): { baseId: string; variantName: string | null } {
  // Display-name first — labels are the source of truth for pairing.
  const display = (model.displayName ?? "").trim()
  if (display) {
    const parsed = parseDisplayVariants(display)
    const slug = slugifyModelLabel(parsed.baseLabel)
    if (slug) {
      return {
        baseId: slug + parsed.contextSuffix,
        variantName: parsed.variantName,
      }
    }
  }

  // Fallback: id suffixes (models with empty displayName)
  const { stem, contextSuffix } = peelContextTier(model.id)
  const stemLower = stem.toLowerCase()
  for (const suffix of DEVIN_VARIANT_SUFFIXES) {
    if (stemLower.endsWith(suffix)) {
      const stemBase = stem.slice(0, -suffix.length)
      if (!stemBase) continue
      return {
        baseId: stemBase + contextSuffix,
        variantName: variantNameFromSuffix(suffix),
      }
    }
    const underscored = suffix.replace(/-/g, "_")
    if (underscored !== suffix && stemLower.endsWith(underscored)) {
      const stemBase = stem.slice(0, -underscored.length)
      if (!stemBase) continue
      return {
        baseId: stemBase + contextSuffix,
        variantName: variantNameFromSuffix(underscored),
      }
    }
  }
  return { baseId: stem + contextSuffix, variantName: null }
}

/**
 * Convert human-readable variant names to Devin's parameter format.
 * 
 * This function maps display names like "Low Fast", "Thinking", "Max" to Devin's
 * internal parameter structure that gets reconstructed into wire model IDs at request time.
 * 
 * Devin's wire IDs are flat: `claude-opus-5-medium-fast`, `swe-1-7-lightning-max`, etc.
 * OpenCode uses parameter-only variants, so we need to synthesize these parameters from
 * display names, then reconstruct the wire ID later using `wireModelIdFromBaseAndParams`.
 * 
 * Parameter mapping:
 * - "fast" / "priority" → fast=true (accelerated generation)
 * - "lightning" → lightning=true (SWE Lightning models)
 * - "slow" → slow=true (slower, more thorough)
 * - "reasoning" → reasoning=true (extended reasoning mode)
 * - "thinking" / "no thinking" → thinking=true/false (chain-of-thought)
 * - "low" / "medium" / "high" / "max" / "xhigh" / "none" / "minimal" → effort=<value>
 * - Other terms → variant=<value> (fallback for unknown variants)
 * 
 * The logic handles compound terms like "no thinking" by treating "no" as a modifier
 * for "thinking" rather than a standalone variant.
 * 
 * @param variantName - Human-readable variant name from display labels
 * @returns Array of parameter objects that can be reconstructed into wire IDs
 */
function variantNameToParams(variantName: string): Array<{ id: string; value: string }> {
  const lower = variantName.toLowerCase().replace(/x-high/g, "xhigh")
  const parts = lower.split(/\s+/).filter(Boolean)
  const params: Array<{ id: string; value: string }> = []
  const hasThinking = parts.includes("thinking")
  const hasNo = parts.includes("no")
  for (const part of parts) {
    if (part === "fast") params.push({ id: "fast", value: "true" })
    else if (part === "priority") params.push({ id: "priority", value: "true" })
    else if (part === "lightning") params.push({ id: "lightning", value: "true" })
    else if (part === "slow") params.push({ id: "slow", value: "true" })
    else if (part === "reasoning") params.push({ id: "reasoning", value: "true" })
    else if (part === "thinking") {
      params.push({ id: "thinking", value: hasNo ? "false" : "true" })
    } else if (part === "no") {
      if (!hasThinking) params.push({ id: "variant", value: part })
    } else if (["low", "medium", "high", "max", "xhigh", "none", "minimal"].includes(part)) {
      params.push({ id: "effort", value: part })
    } else if (part) {
      params.push({ id: "variant", value: part })
    }
  }
  const deduped = params.filter(
    (p) => !(p.id === "variant" && p.value === "no" && hasThinking),
  )
  return deduped.length ? deduped : [{ id: "variant", value: lower }]
}

/** Effort ladder used for stable variant ordering in the catalog / TUI. */
const EFFORT_SORT_RANK: Record<string, number> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
}

/**
 * Sort key:
 * 1. non-Lightning before Lightning (SWE: Medium, Max, Lightning Medium, Lightning Max)
 * 2. effort ladder (None < Minimal < Low < … < Max)
 * 3. non-Fast before Fast within the same effort (Low, Low Fast, Medium, …)
 * 4. No Thinking before Thinking
 *
 * Lightning is primary so SWE Lightning variants sit after the full base
 * effort ladder — not interleaved (Medium, Lightning Medium, Max, …).
 */
function variantSortKey(name: string): [number, number, number, number, string] {
  const lower = name.toLowerCase().replace(/x-high/g, "xhigh")
  const parts = lower.split(/\s+/).filter(Boolean)
  const lightning = parts.includes("lightning") ? 1 : 0
  const fast = parts.includes("fast") || parts.includes("priority") ? 1 : 0
  let effort = 50
  for (const part of parts) {
    if (part in EFFORT_SORT_RANK) effort = EFFORT_SORT_RANK[part]!
  }
  // "No Thinking" / bare "Thinking" with no explicit effort → treat as none-tier
  if (
    parts.includes("thinking") &&
    !parts.some((part) => part in EFFORT_SORT_RANK)
  ) {
    effort = 0
  }
  if (name === "Default") effort = -1
  const thinking =
    parts.includes("thinking") && !parts.includes("no")
      ? 1
      : parts.includes("reasoning")
        ? 1
        : 0
  return [lightning, effort, fast, thinking, name]
}

function compareVariantNames(a: string, b: string): number {
  const ka = variantSortKey(a)
  const kb = variantSortKey(b)
  for (let i = 0; i < 4; i++) {
    const da = ka[i] as number
    const db = kb[i] as number
    if (da !== db) return da - db
  }
  return ka[4].localeCompare(kb[4])
}

/**
 * When nearly every variant is an effort×Thinking combo ("Low Thinking",
 * "High Thinking Fast", …), strip the redundant "Thinking" word so the
 * picker reads like Opus 5: Low, Low Fast, Medium, Medium Fast, …
 * Keep explicit "No Thinking" / "No Thinking Fast" opt-outs.
 */
function simplifyVariantLabel(name: string, stripThinking: boolean): string {
  let out = name
  if (stripThinking && !/^no\s+thinking\b/i.test(out)) {
    out = out.replace(/\s+Thinking\b/gi, "").replace(/\s+/g, " ").trim()
  }
  // Prefer XHigh over Xhigh for display
  out = out.replace(/\bXhigh\b/g, "XHigh")
  return out || name
}

function shouldStripThinkingLabels(names: string[]): boolean {
  const thinkingish = names.filter(
    (n) => /\bthinking\b/i.test(n) && !/^no\s+thinking\b/i.test(n),
  )
  // At least two effort×thinking variants → Thinking is the default mode, not a label
  return thinkingish.length >= 2
}

/** True if this group can reason — any member flag OR any thinking/effort variant. */
function groupSupportsReasoning(
  members: Array<{ model: ModelInfo; variantName: string | null }>,
): boolean {
  for (const { model, variantName } of members) {
    if (model.supportsThinking) return true
    const vn = (variantName ?? "").toLowerCase().replace(/x-high/g, "xhigh")
    if (!vn || vn === "default") continue
    // Explicit thinking/reasoning variants (not the "No Thinking" opt-out alone)
    if (/\bthinking\b/.test(vn) && !/^no\s+thinking(\s+fast)?$/.test(vn)) return true
    if (/\breasoning\b/.test(vn)) return true
    // Effort ladder is the reasoning control for Opus 5 / GPT / Gemini / …
    if (/\b(none|minimal|low|medium|high|xhigh|max)\b/.test(vn)) return true
  }
  return false
}

export function modelsToConfig(models: ModelInfo[]): Record<string, any> {
  // Fresh alias table — opaque PRIVATE_* wire ids are registered per variant below.
  clearDevinWireIdAliases()

  // Group flat Devin models by baseId stripping effort/speed suffixes
  const groups = new Map<string, Array<{ model: ModelInfo; variantName: string | null }>>()
  const baseDisplayByGroup = new Map<string, string>()
  for (const m of models) {
    const { baseId, variantName } = splitDevinVariant(m)
    const entry = groups.get(baseId)
    if (entry) {
      entry.push({ model: m, variantName })
    } else {
      groups.set(baseId, [{ model: m, variantName }])
      // Prefer the display label with variant phrases peeled; keep "1M" on the name
      // so context-tier siblings don't look identical in the catalog.
      if ((m.displayName ?? "").trim()) {
        const parsed = parseDisplayVariants(m.displayName!)
        const label = parsed.contextSuffix
          ? `${parsed.baseLabel} 1M`
          : parsed.baseLabel
        baseDisplayByGroup.set(baseId, label || baseName(m))
      } else {
        baseDisplayByGroup.set(baseId, baseName(m))
      }
    }
  }

  const ambiguous = thinkingSuffixBaseNames(models)
  const out: Record<string, any> = {}

  for (const [baseId, members] of groups) {
    // Single member without variant → flat model (preserve 1:1 wire id)
    if (members.length === 1 && members[0]!.variantName === null) {
      const m = members[0]!.model
      const thinkingSuffix = !!m.supportsThinking && ambiguous.has(baseName(m))
      out[m.id] = applyDevinModelCost(m.id, modelInfoToConfig(m, { thinkingSuffix }))
      continue
    }

    // Multiple variants → collapse into one base entry with variants
    // Pick representative for base metadata (prefer non-variant member)
    const representative =
      members.find((mm) => mm.variantName === null)?.model ?? members[0]!.model
    const baseDisplay = baseDisplayByGroup.get(baseId) ?? baseName(representative)
    // Reasoning if ANY variant/member can think — don't inherit only the
    // non-thinking representative (Opus 4.6 / Sonnet 4.5) or miss effort-only
    // ladders that omit "Thinking" in the label (Opus 5).
    const supportsReasoning = groupSupportsReasoning(members)
    const supportsImages = members.some((mm) => mm.model.supportsImages === true)
      ? true
      : members.every((mm) => mm.model.supportsImages === false)
        ? false
        : representative.supportsImages
    const maxContext = Math.max(
      0,
      ...members.map((mm) => mm.model.maxContext ?? 0),
      representative.maxContext ?? 0,
    )
    const maxOutput = Math.max(
      0,
      ...members.map((mm) => mm.model.maxOutput ?? 0),
      representative.maxOutput ?? 0,
    )
    const cost = members.find((mm) => mm.model.cost)?.model.cost
    const baseInfo: ModelInfo = {
      id: baseId,
      displayName: baseDisplay,
      ...(representative.family ? { family: representative.family } : {}),
      ...(supportsReasoning ? { supportsThinking: true } : {}),
      ...(representative.supportsAgent ? { supportsAgent: true } : {}),
      ...(supportsImages !== undefined ? { supportsImages } : {}),
      ...(maxContext > 0 ? { maxContext } : {}),
      ...(maxOutput > 0 ? { maxOutput } : {}),
      ...(cost ? { cost } : {}),
      variants: [],
    }
    // Do not append a " Thinking" name suffix — variants already express that.
    const baseConfig = modelInfoToConfig(baseInfo, { thinkingSuffix: false })
    baseConfig.name = baseDisplay
    baseConfig.reasoning = supportsReasoning

    // Build variants map — Cursor shape: parameters only, one OpenCode model id.
    // Wire uid is resolved via alias table (opaque PRIVATE_*) or suffix synthesis.
    const hasThinkingSibling = members.some(
      (mm) => mm.variantName === "Thinking" || /(^|\s)Thinking$/i.test(mm.variantName ?? ""),
    )
    type VariantRow = { key: string; params: Array<{ id: string; value: string }>; wireId: string }
    const rows: VariantRow[] = []
    const usedKeys = new Set<string>()
    const rawKeys: string[] = []
    for (const { model, variantName } of members) {
      // Bare base paired with a Thinking sibling → "No Thinking" (not "Default")
      const rawKey = variantName ?? (hasThinkingSibling ? "No Thinking" : "Default")
      rawKeys.push(rawKey)
      const params = variantName
        ? variantNameToParams(variantName)
        : hasThinkingSibling
          ? [{ id: "thinking", value: "false" }]
          : []
      rows.push({ key: rawKey, params, wireId: model.id })
    }
    const stripThinking = shouldStripThinkingLabels(rawKeys)
    for (const row of rows) {
      let key = simplifyVariantLabel(row.key, stripThinking)
      let n = 2
      const base = key
      while (usedKeys.has(key)) key = `${base} ${n++}`
      usedKeys.add(key)
      row.key = key
    }
    rows.sort((a, b) => compareVariantNames(a.key, b.key))

    const variants: Record<string, Record<string, unknown>> = {}
    for (const row of rows) {
      registerDevinWireIdAlias(baseId, row.params, row.wireId)
      variants[row.key] = {
        [DEVIN_VARIANT_PARAMETERS_KEY]: row.params,
      }
    }
    baseConfig.variants = variants
    // Default = first sorted variant (lowest effort / No Thinking), not discovery order.
    const defaultRow =
      rows.find((r) => r.key === "No Thinking" || r.key === "None" || r.key === "Default") ??
      rows[0]
    if (defaultRow && defaultRow.params.length > 0) {
      baseConfig.options = {
        [DEVIN_VARIANT_PARAMETERS_KEY]: defaultRow.params,
      }
    }
    out[baseId] = applyDevinModelCost(baseId, baseConfig)
  }

  return out
}

export function modelInfoToConfigForTest(mi: ModelInfo): unknown {
  return modelInfoToConfig(mi)
}
