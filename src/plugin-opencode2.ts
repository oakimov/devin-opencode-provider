import { DEVIN_PROVIDER_ID } from "./shared.js"
import { createSdk, devinApiBaseURL, isDevinPackage } from "./plugin-core.js"
import { opencodeGlobalCacheDir } from "./context/paths.js"
import { discoverModels, isCacheFresh, readCache, type ModelInfo } from "./models.js"
import type { CreateDevinOptions } from "./index.js"
import type { Cleanup, PluginContext, Plugin2 } from "./opencode2/types.js"
import { applyDevinProvider, applyDevinModels } from "./opencode2/catalog.js"
import { applyDevinIntegration, resolveDevinAccessToken } from "./opencode2/integration.js"

async function loadModels(cacheDir: string, accessToken: string | undefined): Promise<ModelInfo[]> {
  const cached = await readCache(cacheDir)
  if (cached?.models.length && isCacheFresh(cached)) return cached.models
  if (accessToken) {
    try {
      return await discoverModels(accessToken, cacheDir, { baseURL: devinApiBaseURL() })
    } catch {}
  }
  return cached?.models ?? []
}

const plugin: Plugin2 = {
  id: "devin.provider",
  setup: async (ctx: PluginContext): Promise<Cleanup> => {
    const cacheDir = opencodeGlobalCacheDir()
    const registrations: Array<{ dispose: () => Promise<void> }> = []
    const track = async (p: Promise<{ dispose: () => Promise<void> }>) => { registrations.push(await p) }

    let models: ModelInfo[] = []
    await track(ctx.integration.transform(applyDevinIntegration))

    let cachedToken: string | undefined
    let tokenInflight: Promise<string | undefined> | undefined
    const accessToken = async (): Promise<string | undefined> => {
      if (cachedToken) return cachedToken
      tokenInflight ??= resolveDevinAccessToken(ctx.integration).finally(() => { tokenInflight = undefined })
      const token = await tokenInflight
      if (token) cachedToken = token
      return token
    }

    await track(ctx.catalog.transform((draft) => {
      applyDevinProvider(draft)
      applyDevinModels(draft, models)
    }))

    await track(ctx.aisdk.hook("sdk", async (event) => {
      if (event.sdk) return
      if (!isDevinPackage(event.package, event.model.providerID)) return
      const token = await accessToken()
      event.sdk = createSdk({
        name: event.model.providerID || DEVIN_PROVIDER_ID,
        ...(token ? { accessToken: token } : {}),
        workspaceRoot: process.cwd(),
        cacheDir,
        ...event.options,
      } as CreateDevinOptions)
    }))

    await track(ctx.aisdk.hook("language", (event) => {
      if (event.language) return
      if (event.model.providerID !== DEVIN_PROVIDER_ID) return
      if (typeof event.sdk?.languageModel !== "function") return
      event.language = event.sdk.languageModel(event.model.modelID || event.model.id)
    }))

    await track(ctx.tool.transform((draft) => {
      draft.add({
        name: "devin_image_save",
        description: "Save a Devin-generated image. Takes only the id of an already-generated image.",
        input: { type: "object", properties: { image_id: { type: "string" } }, required: ["image_id"], additionalProperties: false },
        execute: async () => ({ title: "devin_image_save", output: "not implemented", metadata: {} }),
      })
    }))

    let modelsLoaded = false
    let ensureInflight: Promise<void> | undefined
    const ensureModels = (): Promise<void> => {
      if (modelsLoaded) return Promise.resolve()
      ensureInflight ??= (async () => {
        try {
          const token = await accessToken()
          const discovered = await loadModels(cacheDir, token)
          if (!discovered.length) return
          models = discovered
          modelsLoaded = true
          await ctx.catalog.reload().catch(() => {})
        } finally { ensureInflight = undefined }
      })()
      return ensureInflight
    }
    const RETRY_INTERVAL_MS = 3_000
    const RETRY_WINDOW_MS = 300_000
    const startedAt = Date.now()
    const retry = setInterval(() => {
      if (modelsLoaded || Date.now() - startedAt > RETRY_WINDOW_MS) { clearInterval(retry); return }
      void ensureModels()
    }, RETRY_INTERVAL_MS)
    ;(retry as unknown as { unref?: () => void }).unref?.()
    void ensureModels()

    return async () => {
      clearInterval(retry)
      for (const r of registrations.reverse()) await r.dispose().catch(() => {})
    }
  },
}

export default plugin
