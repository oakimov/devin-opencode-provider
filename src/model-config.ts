import type { ModelInfo } from "./models.js"

export function modelsToConfig(models: ModelInfo[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const m of models) {
    out[m.id] = {
      name: m.displayName ?? m.id,
      limit: {
        context: m.maxContext ?? 200_000,
        output: m.maxOutput ?? 32_000,
      },
    }
  }
  return out
}

export function modelInfoToConfig(info: ModelInfo): unknown {
  return {
    name: info.displayName ?? info.id,
    limit: { context: info.maxContext ?? 200_000, output: info.maxOutput ?? 32_000 },
  }
}
