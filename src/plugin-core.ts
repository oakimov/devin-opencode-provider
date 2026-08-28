import { DEVIN_PROVIDER_ID, PRIMARY_PROVIDER_ID, WINDSURF_API_HOST } from "./shared.js"
import { createDevinLanguageModel } from "./language-model.js"
import type { CreateDevinOptions } from "./index.js"

export type DevinSdk = {
  languageModel(modelId: string): ReturnType<typeof createDevinLanguageModel>
}

export function createSdk(options: CreateDevinOptions): DevinSdk {
  const providerId = options.name || PRIMARY_PROVIDER_ID
  return {
    languageModel(modelId: string) {
      return createDevinLanguageModel(modelId, providerId, options)
    },
  }
}

export function isDevinPackage(pkg: string, providerID: string): boolean {
  if (providerID === DEVIN_PROVIDER_ID || providerID === "windsurf" || providerID === "cognition") return true
  return pkg.includes("devin-opencode-provider") || /devin-opencode-provider[/\\]dist[/\\]index\.js/.test(pkg)
}

export function devinApiBaseURL(): string {
  return process.env.DEVIN_API_BASE_URL ?? process.env.WINDSURF_API_BASE_URL ?? `https://${WINDSURF_API_HOST}`
}
