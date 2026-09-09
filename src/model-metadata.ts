import { DEVIN_MODEL_CAPABILITIES, DEVIN_MODEL_CONTEXTS } from "./pricing-data.js"

export type DevinModelContext = { maxContext?: number; maxContextForMaxMode?: number }
export type DevinModelCapabilities = {
  supportsImages: boolean
  supportsVideo?: boolean
  supportsDocuments?: boolean
}

export function getDocumentedDevinModelContext(modelId: string): DevinModelContext | undefined {
  const context = (DEVIN_MODEL_CONTEXTS as Record<string, DevinModelContext>)[modelId]
  return context ? { ...context } : undefined
}

export function getDocumentedDevinModelCapabilities(modelId: string): DevinModelCapabilities | undefined {
  const capabilities = (DEVIN_MODEL_CAPABILITIES as Record<string, DevinModelCapabilities>)[modelId]
  return capabilities ? { ...capabilities } : undefined
}

export function resolveDevinModelSupportsImages(modelId: string, availableModelsValue?: boolean): boolean {
  return availableModelsValue ?? getDocumentedDevinModelCapabilities(modelId)?.supportsImages ?? false
}

export function resolveDevinModelSupportsVideo(modelId: string, availableModelsValue?: boolean): boolean {
  return availableModelsValue
    ?? getDocumentedDevinModelCapabilities(modelId)?.supportsVideo
    ?? resolveDevinModelSupportsImages(modelId, undefined)
}

export function resolveDevinModelSupportsDocuments(modelId: string, availableModelsValue?: boolean): boolean {
  // Prefer live ModelFeatures; otherwise allow docs whenever images work (OpenCode attach UX).
  return availableModelsValue
    ?? getDocumentedDevinModelCapabilities(modelId)?.supportsDocuments
    ?? resolveDevinModelSupportsImages(modelId, undefined)
}
