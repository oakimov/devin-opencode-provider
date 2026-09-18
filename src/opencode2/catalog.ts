import { pathToFileURL } from "node:url"
import { DEVIN_PROVIDER_ID } from "../shared.js"
import { type ModelInfo } from "../models.js"
import { modelsToConfig } from "../model-config.js"
import { toOpenCode2Costs, type OpenCode2ModelCost, type OpenCodeModelCost } from "../pricing.js"
import type { ConnectionInfo, ModelVariantInfo, ProviderEditor } from "./types.js"

/**
 * In-memory provider registration for the OpenCode 2.0 plugin — the replacement
 * for the classic plugin's `config` hook.
 *
 * Model naming, thinking suffixes, and long-context tiering are NOT reimplemented
 * here: we run the shared `modelsToConfig` and translate its output into the 2.0
 * `Model.Info` shape, so every surface exposes an identical model list.
 */

/** Integration id owning Devin credentials. Matches the provider id. */
export const DEVIN_INTEGRATION_ID = DEVIN_PROVIDER_ID

/**
 * `aisdk:` selects OpenCode 2.0's AI SDK path, which is what surfaces the
 * `aisdk.hook("sdk")` / `("language")` extension points we supply the provider
 * through. The suffix is this package's npm name so the host's built-in
 * fallback can still resolve it if our own hook is ever bypassed — that
 * fallback runs `npm.add(pkg)` against the *published* registry into
 * `<host-cache>/packages/<pkg>/node_modules/<pkg>`, ignoring any local
 * `file://` plugin path this process was loaded from.
 *
 * `DEVIN_OPENCODE2_DEV_ENTRY` overrides the suffix with an `aisdk:file://…`
 * spec instead, pointed at a local built entry file (e.g. `dist/index.js`,
 * which exports `createDevin`). The host's fallback recognizes `file://`
 * specs and imports them directly, skipping `npm.add` — the only way to
 * exercise a local build through that fallback path short of publishing.
 * Unset in production; only meant for local `opencode2 run` testing.
 */
export const DEVIN_AISDK_PACKAGE = process.env.DEVIN_OPENCODE2_DEV_ENTRY
  ? `aisdk:${pathToFileURL(process.env.DEVIN_OPENCODE2_DEV_ENTRY).href}`
  : "aisdk:devin-opencode-provider"

/**
 * Plain-object `Model.Info` equivalent used by `ctx.provider.transform`.
 */
export type CatalogModelInfo = {
  id: string
  modelID: string
  providerID: string
  name: string
  capabilities: {
    tools: boolean
    input: string[]
    output: string[]
  }
  limit: {
    context: number
    output: number
  }
  variants: ModelVariantInfo[]
  status: "active"
  enabled: true
  time: { released: number }
  cost: OpenCode2ModelCost[]
  settings?: Record<string, unknown>
}

/**
 * OpenCode 2.0 sorts the model picker by `time.released` descending.
 * `0` sinks every Devin model under the fold. Stamp process start (plus
 * catalog order) so the list stays discoverable and stable for this daemon.
 */
export const OPENCODE2_CATALOG_RELEASED_BASE_MS = Date.now()

/** Translate one `modelsToConfig` entry into the 2.0 `Model.Info` shape. */
export function modelConfigEntryToInfo(
  id: string,
  entry: Record<string, any>,
  released = OPENCODE2_CATALOG_RELEASED_BASE_MS,
): CatalogModelInfo {
  const options = entry.options as Record<string, unknown> | undefined
  // OpenCode id === catalog id. Devin wire uids (`…-medium`, `…-low-fast`) are
  // reconstructed in the language model from variant parameters — same shape as
  // Cursor (one model id, parameter-only variants).
  const variants: ModelVariantInfo[] = Object.entries(
    (entry.variants ?? {}) as Record<string, Record<string, unknown>>,
  ).map(([variantId, settings]) => ({ id: variantId, settings: { ...settings } }))

  const inputModalities = Array.isArray(entry.modalities?.input)
    ? entry.modalities.input.filter((modality: unknown): modality is string => typeof modality === "string")
    : ["text"]
  const outputModalities = Array.isArray(entry.modalities?.output)
    ? entry.modalities.output.filter((modality: unknown): modality is string => typeof modality === "string")
    : ["text"]

  const info: CatalogModelInfo = {
    id,
    modelID: id,
    providerID: DEVIN_PROVIDER_ID,
    name: entry.name ?? id,
    capabilities: {
      tools: entry.tool_call !== false,
      input: inputModalities,
      output: outputModalities,
    },
    limit: {
      context: entry.limit?.context ?? 200_000,
      output: entry.limit?.output ?? 8192,
    },
    variants,
    status: "active",
    enabled: true,
    time: { released: released > 0 ? released : OPENCODE2_CATALOG_RELEASED_BASE_MS },
    cost: toOpenCode2Costs(entry.cost as OpenCodeModelCost | undefined),
  }
  if (options) info.settings = { ...options }
  return info
}

/** Full model map for the in-memory provider inventory. */
export function modelsToCatalogModelMap(models: ModelInfo[]): Record<string, CatalogModelInfo> {
  const config = modelsToConfig(models)
  const entries = Object.entries(config)
  const out: Record<string, CatalogModelInfo> = {}
  for (const [index, [id, entry]] of entries.entries()) {
    // Earlier catalog entries sort ahead of later ones (descending released).
    const released = OPENCODE2_CATALOG_RELEASED_BASE_MS + (entries.length - index)
    out[id] = modelConfigEntryToInfo(id, entry as Record<string, any>, released)
  }
  return out
}

const DEVIN_PROVIDER_INFO = {
  id: DEVIN_PROVIDER_ID,
  name: "Devin",
  activation: "enabled",
  package: DEVIN_AISDK_PACKAGE,
  integrationID: DEVIN_INTEGRATION_ID,
} as const

function clearDevinProvider(editor: ProviderEditor): void {
  if (typeof editor.remove === "function") {
    editor.remove(DEVIN_PROVIDER_ID)
    return
  }
  // Hosts whose editor only upserts still need an explicit empty write.
  // `disabled` keeps a failed credential switch out of the picker.
  editor.add({
    info: { ...DEVIN_PROVIDER_INFO, activation: "disabled" },
    models: [],
  })
}

/**
 * Publish discovered Devin models into the live provider inventory.
 *
 * Empty input is a no-op unless `clearWhenEmpty` is set (credential switch
 * that could not load the new account). When the host exposes `remove`,
 * call it before `add` so replacement does not depend on upsert semantics.
 */
export function applyDevinProviderInventory(
  editor: ProviderEditor,
  models: ModelInfo[],
  sourceConnection?: ConnectionInfo,
  options?: { clearWhenEmpty?: boolean },
): void {
  if (models.length === 0) {
    if (options?.clearWhenEmpty) clearDevinProvider(editor)
    return
  }

  if (typeof editor.remove === "function") editor.remove(DEVIN_PROVIDER_ID)
  editor.add({
    info: { ...DEVIN_PROVIDER_INFO },
    models: Object.values(modelsToCatalogModelMap(models)),
    ...(sourceConnection ? { sourceConnection } : {}),
  })
}
