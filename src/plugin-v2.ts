import { DEVIN_PROVIDER_ID } from "./shared.js"
import { createSdk, isDevinPackage } from "./plugin-core.js"
import type { CreateDevinOptions } from "./index.js"

type PromiseV2Plugin = {
  id: string
  setup: (ctx: {
    aisdk: {
      sdk: (callback: (event: any) => void) => Promise<void>
      language: (callback: (event: any) => void) => Promise<void>
    }
  }) => Promise<void>
}

function define(plugin: PromiseV2Plugin): PromiseV2Plugin {
  return plugin
}

const plugin: PromiseV2Plugin = define({
  id: "devin.provider",
  setup: async (ctx) => {
    await ctx.aisdk.sdk((event) => {
      if (event.sdk) return
      if (!isDevinPackage(event.package, event.model.providerID)) return
      event.sdk = createSdk({
        name: event.model.providerID || DEVIN_PROVIDER_ID,
        ...event.options,
      } as CreateDevinOptions)
    })

    await ctx.aisdk.language((event) => {
      if (event.model.providerID !== DEVIN_PROVIDER_ID) return
      if (event.language) return
      if (typeof event.sdk?.languageModel !== "function") return
      event.language = event.sdk.languageModel(event.model.api.id)
    })
  },
})

export default plugin
