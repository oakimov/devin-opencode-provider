import { pathToFileURL } from "node:url"
import { DEVIN_PROVIDER_ID } from "../shared.js"
import { type ModelInfo } from "../models.js"
import { modelsToConfig } from "../model-config.js"
import { toOpenCode2Costs, type OpenCodeModelCost } from "../pricing.js"
import type { CatalogDraft, ModelVariantInfo } from "./types.js"

/**
 * Catalog registration for the OpenCode 2.0 plugin — the replacement for the
 * classic plugin's `config` hook.
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
 * `DynamicProviderPlugin` can still resolve it if our own hook is ever
 * bypassed — that fallback runs `npm.add(pkg)` against the *published*
 * registry into `<host-cache>/packages/<pkg>/node_modules/<pkg>`, ignoring
 * any local `file://` plugin path this process was loaded from.
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

/** Register (or update) the Devin provider entry. `update` is an upsert. */
export function applyDevinProvider(draft: CatalogDraft): void {
  draft.provider.update(DEVIN_PROVIDER_ID, (provider) => {
    provider.id = DEVIN_PROVIDER_ID
    provider.name = "Devin"
    provider.package = DEVIN_AISDK_PACKAGE
    // Links the provider to the integration that stores its credentials, so
    // `connection.active(...)` resolves the token the user set up via /connect.
    provider.integrationID = DEVIN_INTEGRATION_ID
  })
}

/** Translate one `modelsToConfig` entry into the 2.0 `Model.Info` shape. */
function applyModelEntry(draft: CatalogDraft, id: string, entry: Record<string, any>): void {
  const options = entry.options as Record<string, unknown> | undefined
  // OpenCode id === catalog id. Devin wire uids (`…-medium`, `…-low-fast`) are
  // reconstructed in the language model from variant parameters — same shape as
  // Cursor (one model id, parameter-only variants).
  const variants: ModelVariantInfo[] = Object.entries(
    (entry.variants ?? {}) as Record<string, Record<string, unknown>>,
  ).map(([variantId, settings]) => ({ id: variantId, settings: { ...settings } }))

  draft.model.update(DEVIN_PROVIDER_ID, id, (model) => {
    model.id = id
    model.modelID = id
    model.providerID = DEVIN_PROVIDER_ID
    model.name = entry.name
    const inputModalities = Array.isArray(entry.modalities?.input)
      ? entry.modalities.input.filter((modality: unknown): modality is string => typeof modality === "string")
      : ["text"]
    const outputModalities = Array.isArray(entry.modalities?.output)
      ? entry.modalities.output.filter((modality: unknown): modality is string => typeof modality === "string")
      : ["text"]
    model.capabilities = {
      tools: entry.tool_call !== false,
      input: inputModalities,
      output: outputModalities,
    }
    model.limit = { context: entry.limit.context, output: entry.limit.output }
    model.variants = variants
    model.status = "active"
    model.enabled = true
    model.time = { released: 0 }
    model.cost = toOpenCode2Costs(entry.cost as OpenCodeModelCost | undefined)
    // Default variant parameters only — language-model synthesizes the wire uid.
    if (options) model.settings = { ...options }
  })
}

/** Register every discovered Devin model. Safe to re-run; `update` upserts. */
export function applyDevinModels(draft: CatalogDraft, models: ModelInfo[]): void {
  const config = modelsToConfig(models)
  for (const [id, entry] of Object.entries(config)) {
    applyModelEntry(draft, id, entry as Record<string, any>)
  }
}
