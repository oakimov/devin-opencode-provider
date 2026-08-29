import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import * as zlib from "node:zlib"
import { MODEL_CACHE_FILE, MODEL_CACHE_SCHEMA_VERSION, MODEL_CACHE_TTL_MS } from "./shared.js"
import { buildMetadata } from "./protocol/metadata.js"
import { concat, encodeMessage, iterFields } from "./protocol/wire.js"
import { getCachedUserJwt } from "./auth.js"
import { trace } from "./debug.js"

export const DEVIN_VARIANT_PARAMETERS_KEY = "devinVariantParameters"
export const DEVIN_WIRE_MODEL_ID_KEY = "devinModelId"

export type ModelParameterValue = { id: string; value: string }

export type ModelVariant = {
  key: string
  parameterValues: ModelParameterValue[]
  displayName: string
  isDefaultNonMax: boolean
  isDefaultMax: boolean
}

export type ModelInfo = {
  id: string
  displayName?: string
  family?: string
  supportsThinking?: boolean
  supportsAgent?: boolean
  supportsImages?: boolean
  maxContext?: number
  maxContextForMaxMode?: number
  supportsMaxMode?: boolean
  maxOutput?: number
  variants: ModelVariant[]
  cost?: {
    input: number
    output: number
    cache_read?: number
    cache_write?: number
  }
}

export class DevinVariantSelectionError extends Error {
  constructor(message: string) {
    super(`Devin variant selection ${message}`)
    this.name = "DevinVariantSelectionError"
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function optionalString(
  record: Record<string, unknown>,
  names: readonly string[],
): string | undefined | null {
  for (const name of names) {
    if (!Object.hasOwn(record, name)) continue
    if (record[name] === undefined) return undefined
    return typeof record[name] === "string" ? record[name] : null
  }
  return undefined
}

function optionalBoolean(
  record: Record<string, unknown>,
  names: readonly string[],
): boolean | undefined | null {
  for (const name of names) {
    if (!Object.hasOwn(record, name)) continue
    if (record[name] === undefined) return undefined
    return typeof record[name] === "boolean" ? record[name] : null
  }
  return undefined
}

function optionalPositiveNumber(
  record: Record<string, unknown>,
  names: readonly string[],
): number | undefined | null {
  for (const name of names) {
    if (!Object.hasOwn(record, name)) continue
    const value = record[name]
    if (value === undefined) return undefined
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : null
  }
  return undefined
}

export function normalizeModelParameterValues(value: unknown): ModelParameterValue[] | null {
  if (!Array.isArray(value)) return null
  const parameters: ModelParameterValue[] = []
  for (const parameter of value) {
    if (!isPlainRecord(parameter)) return null
    if (!isNonEmptyString(parameter.id) || typeof parameter.value !== "string") return null
    parameters.push({ id: parameter.id, value: parameter.value })
  }
  return parameters
}

function normalizeVariant(value: unknown, fallbackName: string): ModelVariant | null {
  if (!isPlainRecord(value)) return null
  const parameters = normalizeModelParameterValues(
    value.parameterValues ?? (value as Record<string, unknown>).parameter_values ?? [],
  )
  if (!parameters) return null
  const key = optionalString(value, ["key"])
  const displayName = optionalString(value, ["displayName", "display_name"])
  const isDefaultNonMax = optionalBoolean(value, ["isDefaultNonMax", "isDefaultNonMaxConfig", "is_default_non_max_config"])
  const isDefaultMax = optionalBoolean(value, ["isDefaultMax", "isDefaultMaxConfig", "is_default_max_config"])
  if (key === null || displayName === null || isDefaultNonMax === null || isDefaultMax === null) return null
  if ((key !== undefined && !isNonEmptyString(key)) || (displayName !== undefined && !isNonEmptyString(displayName))) return null
  return {
    key: key ?? fallbackName,
    displayName: displayName ?? fallbackName,
    parameterValues: parameters,
    isDefaultNonMax: isDefaultNonMax ?? false,
    isDefaultMax: isDefaultMax ?? false,
  }
}

function normalizeModelInfo(value: unknown): ModelInfo | null {
  if (!isPlainRecord(value) || !isNonEmptyString(value.id)) return null
  const rawVariants = (value as Record<string, unknown>).variants ?? []
  if (!Array.isArray(rawVariants)) return null
  const variants = rawVariants.map((v) => normalizeVariant(v, value.id as string))
  if (variants.some((v) => v === null)) return null
  const displayName = optionalString(value, ["displayName", "display_name"])
  const family = optionalString(value, ["family"])
  const supportsThinking = optionalBoolean(value, ["supportsThinking", "supports_thinking"])
  const supportsAgent = optionalBoolean(value, ["supportsAgent", "supports_agent"])
  const supportsImages = optionalBoolean(value, ["supportsImages", "supports_images"])
  const supportsMaxMode = optionalBoolean(value, ["supportsMaxMode", "supports_max_mode"])
  const maxContext = optionalPositiveNumber(value, ["maxContext", "contextTokenLimit", "context_token_limit"])
  const maxContextForMaxMode = optionalPositiveNumber(value, ["maxContextForMaxMode", "contextTokenLimitForMaxMode", "context_token_limit_for_max_mode"])
  const maxOutput = optionalPositiveNumber(value, ["maxOutput", "max_output_tokens"])
  if (displayName === null || family === null || supportsThinking === null || supportsAgent === null || supportsImages === null || supportsMaxMode === null || maxContext === null || maxContextForMaxMode === null || maxOutput === null) return null
  // cost is optional and persisted from RPC pricing (#32)
  let cost: ModelInfo["cost"] | undefined
  if (Object.hasOwn(value as Record<string, unknown>, "cost")) {
    const rawCost = (value as Record<string, unknown>).cost
    if (rawCost !== undefined) {
      if (!isPlainRecord(rawCost)) return null
      const checkCost = (v: unknown): number | null | undefined => {
        if (v === undefined) return undefined
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null
        return v
      }
      const rc = rawCost as Record<string, unknown>
      const input = checkCost(rc.input)
      const output = checkCost(rc.output)
      const cacheRead = checkCost((rc as any).cache_read ?? (rc as any).cacheRead)
      const cacheWrite = checkCost((rc as any).cache_write ?? (rc as any).cacheWrite)
      if (input === null || output === null || cacheRead === null || cacheWrite === null) return null
      if (input === undefined || output === undefined) return null
      cost = { input: input as number, output: output as number }
      if (cacheRead !== undefined) cost.cache_read = cacheRead as number
      if (cacheWrite !== undefined) cost.cache_write = cacheWrite as number
    }
  }
  return {
    id: value.id,
    ...(displayName === undefined ? {} : { displayName }),
    ...(family === undefined ? {} : { family }),
    ...(supportsThinking === undefined ? {} : { supportsThinking }),
    ...(supportsAgent === undefined ? {} : { supportsAgent }),
    ...(supportsImages === undefined ? {} : { supportsImages }),
    ...(maxContext === undefined ? {} : { maxContext }),
    ...(maxContextForMaxMode === undefined ? {} : { maxContextForMaxMode }),
    ...(maxOutput === undefined ? {} : { maxOutput }),
    ...(supportsMaxMode === undefined ? {} : { supportsMaxMode }),
    ...(cost ? { cost } : {}),
    variants: variants as ModelVariant[],
  }
}

export function normalizeModelCache(value: unknown): ModelCache | null {
  if (!isPlainRecord(value) || !Array.isArray(value.models)) return null
  if (typeof value.fetchedAt !== "number" || !Number.isFinite(value.fetchedAt)) return null
  if (value.schemaVersion !== undefined && (!Number.isSafeInteger(value.schemaVersion) || (value.schemaVersion as number) < 0)) return null
  const models = value.models.map(normalizeModelInfo)
  if (models.some((m) => m === null)) return null
  return { models: models as ModelInfo[], fetchedAt: value.fetchedAt, ...(value.schemaVersion === undefined ? {} : { schemaVersion: value.schemaVersion as number }) }
}

export function extractDevinVariantParameters(
  providerOptions: Record<string, unknown> | undefined,
): ModelParameterValue[] | undefined {
  if (!providerOptions || !Object.hasOwn(providerOptions, DEVIN_VARIANT_PARAMETERS_KEY)) {
    return undefined
  }
  const params = normalizeModelParameterValues(
    providerOptions[DEVIN_VARIANT_PARAMETERS_KEY],
  )
  if (!params) {
    throw new DevinVariantSelectionError(
      "is malformed: devinVariantParameters must be a parameter array",
    )
  }
  return params
}

/** Underscore SCREAMING ids (`MODEL_CLAUDE_4_5_OPUS`) vs kebab (`claude-opus-5`). */
function wireIdStyle(baseId: string): "underscore" | "kebab" {
  return baseId.includes("_") && !baseId.includes("-") ? "underscore" : "kebab"
}

/** Peel trailing `-1m` / `_1M` so effort/thinking segments insert *before* the tier. */
function peelContextTierFromWireId(id: string): { stem: string; contextSuffix: string } {
  const lower = id.toLowerCase()
  for (const tier of ["-1m"] as const) {
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

function appendWireSegments(baseId: string, segments: string[]): string {
  if (segments.length === 0) return baseId
  // `claude-opus-4-6-1m` + thinking → `claude-opus-4-6-thinking-1m` (tier stays last)
  const { stem, contextSuffix } = peelContextTierFromWireId(baseId)
  const body =
    wireIdStyle(stem) === "underscore"
      ? `${stem}_${segments.map((s) => s.toUpperCase()).join("_")}`
      : `${stem}-${segments.join("-")}`
  return body + contextSuffix
}

/**
 * Reconstruct Devin's flat `model_uid` from an OpenCode base id + variant
 * parameters. Devin has no parameter marketplace — each effort/speed/thinking
 * combo is a distinct uid (`claude-opus-5-medium`, `MODEL_…_THINKING`, …).
 * OpenCode only sees the base id with parameter-only variants (Cursor shape).
 *
 * Inverse of `variantNameToParams` in `model-config.ts`.
 * `thinking=false` → bare base (paired non-thinking models have no suffix).
 */
export function wireModelIdFromBaseAndParams(
  baseId: string,
  params: ModelParameterValue[] | undefined,
): string {
  if (!params || params.length === 0) return baseId
  const byId = new Map(params.map((p) => [p.id, p.value]))
  const effort = byId.get("effort")
  const thinking = byId.get("thinking")
  const fast = byId.get("fast") === "true"
  const priority = byId.get("priority") === "true"
  const variant = byId.get("variant")
  const segments: string[] = []

  if (thinking === "false") {
    // Bare / No Thinking — unsuffixed uid, unless effort/fast also present.
  } else if (thinking === "true") {
    if (effort) segments.push(effort)
    segments.push("thinking")
  } else if (effort) {
    segments.push(effort)
  } else if (variant) {
    segments.push(variant)
  }

  if (byId.get("lightning") === "true") {
    // lightning inserts before effort in ids like swe-1-7-lightning-medium
    segments.unshift("lightning")
  }
  if (byId.get("slow") === "true") segments.push("slow")
  if (byId.get("reasoning") === "true") segments.push("reasoning")
  if (fast) segments.push("fast")
  if (priority) segments.push("priority")
  return appendWireSegments(baseId, segments)
}

/** Canonical key for variant param tuples (order-independent). */
function variantParamsKey(params: ModelParameterValue[]): string {
  return [...params]
    .map((p) => `${p.id}=${p.value}`)
    .sort()
    .join("&")
}

/**
 * Wire-id aliases for opaque Devin uids that cannot be synthesized from
 * base+params (e.g. MODEL_PRIVATE_2 / MODEL_PRIVATE_3 for Sonnet 4.5).
 * Populated by `modelsToConfig` each time the catalog is built.
 */
const wireIdAliases = new Map<string, string>()

export function clearDevinWireIdAliases(): void {
  wireIdAliases.clear()
}

export function registerDevinWireIdAlias(
  baseId: string,
  params: ModelParameterValue[],
  wireId: string,
): void {
  wireIdAliases.set(`${baseId}\0${variantParamsKey(params)}`, wireId)
}

export function lookupDevinWireIdAlias(
  baseId: string,
  params: ModelParameterValue[] | undefined,
): string | undefined {
  return wireIdAliases.get(`${baseId}\0${variantParamsKey(params ?? [])}`)
}

export function resolveDevinWireModelId(
  providerOptions: Record<string, unknown> | undefined,
  fallback: string,
  params?: ModelParameterValue[],
): string {
  // Explicit override kept for back-compat / debugging only — catalog no longer emits it.
  const value = providerOptions?.[DEVIN_WIRE_MODEL_ID_KEY]
  if (typeof value === "string" && value.trim()) return value
  let picked = params
  if (
    picked === undefined &&
    providerOptions &&
    Object.hasOwn(providerOptions, DEVIN_VARIANT_PARAMETERS_KEY)
  ) {
    const normalized = normalizeModelParameterValues(
      providerOptions[DEVIN_VARIANT_PARAMETERS_KEY],
    )
    if (normalized) picked = normalized
  }
  // Opaque PRIVATE_* (and any future non-synthesizable) mappings win over suffix synthesis.
  const alias = lookupDevinWireIdAlias(fallback, picked)
  if (alias) return alias
  return wireModelIdFromBaseAndParams(fallback, picked)
}

export type ModelCache = {
  models: ModelInfo[]
  fetchedAt: number
  schemaVersion?: number
}

export function cacheFilePath(cacheDir: string): string {
  return path.join(cacheDir, MODEL_CACHE_FILE)
}

export async function readCache(cacheDir: string): Promise<ModelCache | null> {
  const filePath = cacheFilePath(cacheDir)
  try {
    const data = await readFile(filePath, "utf-8")
    return normalizeModelCache(JSON.parse(data))
  } catch { return null }
}

export function isCacheFresh(cache: ModelCache, ttlMs = MODEL_CACHE_TTL_MS): boolean {
  if (cache.schemaVersion !== MODEL_CACHE_SCHEMA_VERSION) return false
  return Date.now() - cache.fetchedAt < ttlMs
}

async function writeCache(cacheDir: string, models: ModelInfo[]): Promise<void> {
  const normalized = normalizeModelCache({ models, fetchedAt: Date.now(), schemaVersion: MODEL_CACHE_SCHEMA_VERSION })
  if (!normalized) throw new Error("Refusing to write an invalid Devin model cache")
  const filePath = cacheFilePath(cacheDir)
  const directory = path.dirname(filePath)
  const tempPath = path.join(
    directory,
    `.${MODEL_CACHE_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`,
  )
  await mkdir(directory, { recursive: true })
  try {
    await writeFile(tempPath, JSON.stringify(normalized, null, 2), "utf-8")
    await rename(tempPath, filePath)
  } finally { await unlink(tempPath).catch(() => {}) }
}

export async function writeCacheDirect(cacheDir: string, cache: ModelCache): Promise<void> {
  const normalized = normalizeModelCache(cache)
  if (!normalized) throw new Error("Refusing to write an invalid Devin model cache")
  const filePath = cacheFilePath(cacheDir)
  const directory = path.dirname(filePath)
  const tempPath = path.join(
    directory,
    `.${MODEL_CACHE_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`,
  )
  await mkdir(directory, { recursive: true })
  try {
    await writeFile(tempPath, JSON.stringify(normalized, null, 2), "utf-8")
    await rename(tempPath, filePath)
  } finally { await unlink(tempPath).catch(() => {}) }
}

export function isCacheFreshWithTtl(cache: ModelCache, ttlMs = MODEL_CACHE_TTL_MS): boolean {
  return isCacheFresh(cache, ttlMs)
}

// ── Fetch + cache orchestration (mirrors cursor provider) ──

async function fetchDevinModels(accessToken: string, opts: { baseURL?: string; signal?: AbortSignal } = {}): Promise<ModelInfo[]> {
  const base = (opts.baseURL ?? process.env.DEVIN_API_BASE_URL ?? process.env.WINDSURF_API_BASE_URL ?? "https://server.codeium.com").replace(/\/$/, "")
  let userJwt: string | undefined
  try { userJwt = await getCachedUserJwt(accessToken, base, opts.signal) } catch {}
  const metadata = buildMetadata({ apiKey: accessToken, userJwt, sessionId: crypto.randomUUID(), requestId: BigInt(Date.now()), triggerId: crypto.randomUUID() })
  const req = encodeMessage(1, metadata)
  const headers: Record<string, string> = {
    "Content-Type": "application/proto",
    "Connect-Protocol-Version": "1",
    Authorization: `Bearer ${accessToken}`,
  }
  const tryFetch = async (path: string): Promise<Uint8Array | null> => {
    const url = `${base}/${path}`
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: req as unknown as BodyInit,
        signal: opts.signal,
      })
      if (!res.ok) {
        trace(`${path} HTTP ${res.status}`)
        return null
      }
      let buf = new Uint8Array(await res.arrayBuffer())
      if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
        try { buf = zlib.gunzipSync(buf as unknown as Buffer) } catch { /* keep raw */ }
      } else {
        const enc = res.headers.get("content-encoding")
        if (enc?.includes("gzip")) {
          try { buf = zlib.gunzipSync(buf as unknown as Buffer) } catch {}
        }
      }
      return buf
    } catch (e) {
      trace(`${path} failed: ${(e as Error).message}`)
      return null
    }
  }
  const candidates: Array<{ path: string; parser: (b: Uint8Array) => ModelInfo[] }> = [
    { path: "exa.api_server_pb.ApiServerService/GetCascadeModelConfigs", parser: parseCascadeModelConfigs },
    { path: "exa.api_server_pb.ApiServerService/GetCliModelConfigs", parser: parseCascadeModelConfigs },
    { path: "exa.seat_management_pb.SeatManagementService/GetUserStatus", parser: parseModelsFromUserStatus },
    { path: "exa.api_server_pb.ApiServerService/GetUserStatus", parser: parseModelsFromUserStatus },
  ]
  let best: ModelInfo[] = []
  for (const c of candidates) {
    const buf = await tryFetch(c.path)
    if (!buf || buf.length < 10) continue
    const models = c.parser(buf)
    trace(`${c.path} -> ${models.length} models`)
    if (models.length > best.length) best = models
  }
  return best
}

const refreshesByDirectory = new Map<string, Promise<ModelInfo[]>>()

export async function refreshModelCache(
  cacheDir: string,
  fetcher: () => Promise<ModelInfo[]>,
): Promise<ModelInfo[]> {
  const key = path.resolve(cacheDir)
  const existing = refreshesByDirectory.get(key)
  if (existing) return existing
  const refresh = (async () => {
    const models = await fetcher()
    await writeCache(cacheDir, models)
    return models
  })()
  refreshesByDirectory.set(key, refresh)
  try {
    return await refresh
  } finally {
    if (refreshesByDirectory.get(key) === refresh) refreshesByDirectory.delete(key)
  }
}

export async function fetchModels(
  accessToken: string,
  opts: { baseURL?: string; signal?: AbortSignal } = {},
): Promise<ModelInfo[]> {
  return fetchDevinModels(accessToken, opts)
}

/**
 * Fetch live model list with stale-while-revalidate and deduplication.
 * Mirrors cursor provider: fresh cache → serve immediately + background refresh;
 * stale cache → try refresh, serve stale on failure; no cache → must fetch.
 */
export async function discoverModels(accessToken: string, cacheDir: string, opts: { baseURL?: string; signal?: AbortSignal } = {}): Promise<ModelInfo[]> {
  const cached = await readCache(cacheDir)
  const fetcher = () => fetchDevinModels(accessToken, opts)

  // Fresh → serve immediately, refresh in background (fire-and-forget)
  if (cached && isCacheFresh(cached)) {
    void refreshModelCache(cacheDir, fetcher).catch(() => {})
    trace(`discoverModels: serving fresh cache ${cached.models.length} models, background refresh started`)
    return cached.models
  }

  // Stale but present → try refresh, fall back to stale on failure
  if (cached) {
    try {
      const models = await refreshModelCache(cacheDir, fetcher)
      trace(`discoverModels: refreshed stale cache -> ${models.length} models`)
      return models
    } catch (e) {
      trace(`discoverModels: refresh failed, serving stale ${cached.models.length} models: ${(e as Error).message}`)
      return cached.models
    }
  }

  // No cache → must fetch (throws on failure)
  const models = await refreshModelCache(cacheDir, fetcher)
  trace(`discoverModels: initial fetch -> ${models.length} models`)
  return models
}

function shouldShowDisabledForDebug(): boolean {
  const v = process.env.DEVIN_PROVIDER_SHOW_DISABLED
  return v === "1" || v === "true"
}

function f32FromBytes(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return view.getFloat32(0, true)
}

function parseCascadeModelConfigs(buf: Uint8Array): ModelInfo[] {
  const models: ModelInfo[] = []
  const seen = new Set<string>()
  const showDisabled = shouldShowDisabledForDebug()
  for (const f of iterFields(buf)) {
    if (f.num !== 1 || f.wire !== 2 || !(f.value instanceof Uint8Array)) continue
    let label = ""
    let modelUid = ""
    let disabled = false
    let supportsImages: boolean | undefined
    let maxContext: number | undefined
    let maxOutput: number | undefined
    let family: string | undefined
    let modelInfoBytes: Uint8Array | undefined
    let familyBytes: Uint8Array | undefined
    const pricingEntries: Array<{ name: string; price: number }> = []
    for (const sf of iterFields(f.value)) {
      if (sf.num === 1 && sf.wire === 2 && sf.value instanceof Uint8Array) label = new TextDecoder().decode(sf.value).trim()
      else if (sf.num === 4 && sf.wire === 0) disabled = sf.value === 1n || sf.value === 1
      else if (sf.num === 5 && sf.wire === 0) supportsImages = sf.value === 1n || sf.value === 1
      else if (sf.num === 18 && sf.wire === 0) {
        const n = Number(sf.value)
        if (Number.isSafeInteger(n) && n > 0) maxContext = n
      } else if (sf.num === 22 && sf.wire === 2 && sf.value instanceof Uint8Array) modelUid = new TextDecoder().decode(sf.value).trim()
      else if (sf.num === 23 && sf.wire === 2 && sf.value instanceof Uint8Array) modelInfoBytes = sf.value
      else if (sf.num === 30 && sf.wire === 2 && sf.value instanceof Uint8Array) familyBytes = sf.value
      else if (sf.num === 32 && sf.wire === 2 && sf.value instanceof Uint8Array) {
        // Pricing entry: #32 repeated 3x per model (Input, Cached input, Output)
        // Each entry has #1 name, #2 price (fixed32 float), #3 "1M tokens"
        let name = ""
        let price: number | undefined
        for (const pf of iterFields(sf.value)) {
          if (pf.num === 1 && pf.wire === 2 && pf.value instanceof Uint8Array) name = new TextDecoder().decode(pf.value).trim()
          else if (pf.num === 2 && pf.wire === 5 && pf.value instanceof Uint8Array && price === undefined) {
            try { price = f32FromBytes(pf.value as Uint8Array) } catch {}
          }
        }
        if (name && price !== undefined && Number.isFinite(price)) pricingEntries.push({ name, price })
      }
    }
    // Enrich from model_info (#23) when available
    if (modelInfoBytes) {
      for (const mf of iterFields(modelInfoBytes)) {
        if (mf.num === 4 && mf.wire === 0) {
          const n = Number(mf.value)
          if (Number.isSafeInteger(n) && n > 0 && maxContext === undefined) maxContext = n
        } else if (mf.num === 13 && mf.wire === 0) {
          const n = Number(mf.value)
          if (Number.isSafeInteger(n) && n > 0) maxOutput = n
        } else if (mf.num === 8 && mf.wire === 2 && mf.value instanceof Uint8Array) {
          // model_name as fallback family hint
          if (!family) {
            const maybe = new TextDecoder().decode(mf.value).trim()
            if (maybe) family = maybe.split("/")[0]
          }
        }
      }
    }
    if (familyBytes) {
      for (const ff of iterFields(familyBytes)) {
        if (ff.num === 1 && ff.wire === 2 && ff.value instanceof Uint8Array) {
          const fam = new TextDecoder().decode(ff.value).trim()
          if (fam) family = fam
          break
        }
      }
    }
    if (modelUid && !seen.has(modelUid)) {
      if (disabled && !showDisabled) {
        trace(`skip disabled ${modelUid}`)
        continue
      }
      seen.add(modelUid)
      // Infer supportsThinking from label or family metadata (Devin labels like "Claude Opus 4.6 Thinking")
      const supportsThinking = /thinking/i.test(label) || /thinking/i.test(modelUid)
      const displayName = label || modelUid
      const info: ModelInfo = { id: modelUid, displayName, variants: [] }
      if (family) info.family = family
      if (supportsImages !== undefined) info.supportsImages = supportsImages
      if (supportsThinking) info.supportsThinking = true
      // All Devin models support tool calling via Cascade
      info.supportsAgent = true
      if (maxContext !== undefined) info.maxContext = maxContext
      if (maxOutput !== undefined) info.maxOutput = maxOutput
      // Pricing from #32 repeated entries (Input, Cached input, Output) — per 1M tokens
      if (pricingEntries.length > 0) {
        const find = (name: string) => pricingEntries.find(p => p.name.toLowerCase() === name.toLowerCase())?.price
        const input = find("Input")
        const cached = find("Cached input")
        const output = find("Output")
        if (input !== undefined && output !== undefined) {
          info.cost = { input, output }
          if (cached !== undefined) info.cost.cache_read = cached
          // cache_write not separately priced in this RPC; use cached price as fallback
          if (cached !== undefined) info.cost.cache_write = cached
        }
      }
      if (disabled && showDisabled) trace(`including disabled ${modelUid} (DEVIN_PROVIDER_SHOW_DISABLED=1)`)
      models.push(info)
    }
  }
  return models
}

function parseModelsFromUserStatus(buf: Uint8Array): ModelInfo[] {
  const models: ModelInfo[] = []
  // Response shape: GetUserStatusResponse { #1 user_status, #2 plan_info }
  // user_status at #1 contains #33 cascade_model_config_data → client_model_configs
  const seen = new Set<string>()
  const showDisabled = shouldShowDisabledForDebug()
  const scan = (b: Uint8Array, depth = 0): void => {
    if (depth > 6) return
    for (const f of iterFields(b)) {
      if (f.wire === 2 && f.value instanceof Uint8Array) {
        const bytes = f.value
        // Use cascade parser on any blob that looks like repeated field 1
        const sub = parseCascadeModelConfigs(bytes)
        for (const m of sub) if (!seen.has(m.id)) { seen.add(m.id); models.push(m) }
        // Fallback brute for GetUserStatus nested encoding — respect disabled
        for (const inner of iterFields(bytes)) {
          if (inner.num === 22 && inner.wire === 2 && inner.value instanceof Uint8Array) {
            const uid = new TextDecoder().decode(inner.value).trim()
            if (uid && !seen.has(uid) && /^[a-z0-9._\-]+$/i.test(uid) && uid.length >= 3 && uid.length <= 128) {
              let disabled = false
              for (const sf of iterFields(bytes)) if (sf.num === 4 && sf.wire === 0) disabled = sf.value === 1n
              if (disabled && !showDisabled) {
                trace(`skip disabled ${uid} (brute)`)
                continue
              }
              seen.add(uid)
              let label: string | undefined
              for (const lf of iterFields(bytes)) {
                if (lf.num === 1 && lf.wire === 2 && lf.value instanceof Uint8Array) {
                  label = new TextDecoder().decode(lf.value).trim()
                  break
                }
              }
              const displayName = label || uid
              if (disabled && showDisabled) trace(`including disabled ${uid} (brute, DEVIN_PROVIDER_SHOW_DISABLED=1)`)
              models.push({ id: uid, displayName, variants: [] })
            }
          }
        }
        scan(bytes, depth + 1)
      }
    }
  }
  scan(buf)
  return models
}
