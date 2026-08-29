import { describe, it, expect, beforeEach } from "bun:test"
import { modelsToConfig, thinkingSuffixBaseNames, modelInfoToConfig } from "../src/model-config.js"
import { clearDevinWireIdAliases, resolveDevinWireModelId, type ModelInfo } from "../src/models.js"

function makeModel(overrides: Partial<ModelInfo> & { id: string }): ModelInfo {
  return {
    displayName: overrides.displayName ?? overrides.id,
    family: overrides.family,
    supportsThinking: overrides.supportsThinking,
    supportsAgent: overrides.supportsAgent ?? true,
    supportsImages: overrides.supportsImages,
    maxContext: overrides.maxContext ?? 200_000,
    maxOutput: overrides.maxOutput ?? 32_000,
    variants: overrides.variants ?? [],
    ...overrides,
  }
}

describe("thinkingSuffixBaseNames", () => {
  it("detects ambiguous base when same display has thinking and non-thinking", () => {
    const models = [
      makeModel({ id: "a", displayName: "Claude Opus 4.6", supportsThinking: true }),
      makeModel({ id: "b", displayName: "Claude Opus 4.6", supportsThinking: false }),
    ]
    const amb = thinkingSuffixBaseNames(models)
    expect(amb.has("Claude Opus 4.6")).toBe(true)
  })

  it("does not mark unambiguous bases", () => {
    const models = [
      makeModel({ id: "a", displayName: "Claude Opus 5", supportsThinking: true }),
      makeModel({ id: "b", displayName: "Claude Sonnet 5", supportsThinking: true }),
    ]
    const amb = thinkingSuffixBaseNames(models)
    expect(amb.size).toBe(0)
  })

  it("strips markup tags before grouping", () => {
    const models = [
      makeModel({ id: "a", displayName: "<span>Claude Opus 4.6</span>", supportsThinking: true }),
      makeModel({ id: "b", displayName: "Claude Opus 4.6", supportsThinking: false }),
    ]
    expect(thinkingSuffixBaseNames(models).has("Claude Opus 4.6")).toBe(true)
  })
})

describe("modelInfoToConfig", () => {
  it("produces basic config with limits and modalities", () => {
    const cfg = modelInfoToConfig(makeModel({ id: "swe-1-6", displayName: "SWE-1.6", maxContext: 200_000, maxOutput: 16_000, supportsImages: false }))
    expect(cfg.name).toBe("SWE-1.6")
    expect(cfg.limit.context).toBe(200_000)
    expect(cfg.limit.output).toBe(16_000)
    expect(cfg.modalities.input).toEqual(["text"])
    expect(cfg.attachment).toBe(false)
  })

  it("enables image attachment when supported", () => {
    const cfg = modelInfoToConfig(makeModel({ id: "vision", supportsImages: true }))
    expect(cfg.attachment).toBe(true)
    expect(cfg.modalities.input).toEqual(["text", "image"])
  })

  it("sets reasoning true when supportsThinking", () => {
    const cfg = modelInfoToConfig(makeModel({ id: "op", supportsThinking: true }))
    expect(cfg.reasoning).toBe(true)
  })

  it("appends Thinking suffix when requested", () => {
    const cfg = modelInfoToConfig(makeModel({ id: "op", displayName: "Opus 4.6" }), { thinkingSuffix: true })
    expect(cfg.name).toBe("Opus 4.6 Thinking")
  })

  it("uses documented context fallback when maxContext missing", () => {
    const cfg = modelInfoToConfig(makeModel({ id: "claude-opus-4-6", maxContext: undefined }))
    expect(cfg.limit.context).toBeGreaterThan(0)
  })
})

describe("modelsToConfig grouping", () => {
  beforeEach(() => clearDevinWireIdAliases())

  it("groups flat ids into one base with parameter-only variants", () => {
    const models: ModelInfo[] = [
      makeModel({ id: "claude-opus-5-low", displayName: "Claude Opus 5 Low" }),
      makeModel({ id: "claude-opus-5-medium", displayName: "Claude Opus 5 Medium" }),
      makeModel({ id: "claude-opus-5-max-fast", displayName: "Claude Opus 5 Max Fast" }),
    ]
    const cfg = modelsToConfig(models)
    expect(Object.keys(cfg)).toEqual(["claude-opus-5"])
    const variants = Object.keys(cfg["claude-opus-5"].variants)
    expect(variants).toContain("Low")
    expect(variants).toContain("Medium")
    expect(variants).toContain("Max Fast")
    // variants must be parameter-only, no wire ids
    for (const v of Object.values(cfg["claude-opus-5"].variants as Record<string, any>)) {
      expect(v.devinVariantParameters).toBeDefined()
      expect(v.devinModelId).toBeUndefined()
    }
  })

  it("keeps -1m as separate base", () => {
    const cfg = modelsToConfig([
      makeModel({ id: "claude-opus-4-6-low", displayName: "Claude Opus 4.6 Low" }),
      makeModel({ id: "claude-opus-4-6-1m-low", displayName: "Claude Opus 4.6 1M Low" }),
    ])
    expect(cfg["claude-opus-4-6"]).toBeDefined()
    expect(cfg["claude-opus-4-6-1m"]).toBeDefined()
  })

  it("orders effort then Fast within same effort (Low, Low Fast, Medium...)", () => {
    const cfg = modelsToConfig([
      makeModel({ id: "op-medium-fast", displayName: "Opus Medium Fast" }),
      makeModel({ id: "op-low", displayName: "Opus Low" }),
      makeModel({ id: "op-low-fast", displayName: "Opus Low Fast" }),
      makeModel({ id: "op-medium", displayName: "Opus Medium" }),
    ])
    expect(Object.keys(cfg["opus"].variants)).toEqual(["Low", "Low Fast", "Medium", "Medium Fast"])
  })

  it("places Lightning after all non-Lightning for SWE", () => {
    const cfg = modelsToConfig([
      makeModel({ id: "swe-1-7-lightning-medium", displayName: "SWE-1.7 Lightning Medium" }),
      makeModel({ id: "swe-1-7-max", displayName: "SWE-1.7 Max" }),
      makeModel({ id: "swe-1-7-lightning-max", displayName: "SWE-1.7 Lightning Max" }),
      makeModel({ id: "swe-1-7-medium", displayName: "SWE-1.7 Medium" }),
    ])
    expect(Object.keys(cfg["swe-1-7"].variants)).toEqual(["Medium", "Max", "Lightning Medium", "Lightning Max"])
  })

  it("strips redundant Thinking when whole ladder is thinking", () => {
    const cfg = modelsToConfig([
      makeModel({ id: "gpt-5-6-terra-low-thinking", displayName: "GPT-5.6 Terra Low Thinking" }),
      makeModel({ id: "gpt-5-6-terra-medium-thinking", displayName: "GPT-5.6 Terra Medium Thinking" }),
      makeModel({ id: "gpt-5-6-terra-low-thinking-fast", displayName: "GPT-5.6 Terra Low Thinking Fast" }),
      makeModel({ id: "gpt-5-6-terra-no-thinking", displayName: "GPT-5.6 Terra No Thinking" }),
    ])
    const keys = Object.keys(cfg["gpt-5-6-terra"].variants)
    expect(keys).toContain("Low")
    expect(keys).toContain("Low Fast")
    expect(keys).toContain("Medium")
    expect(keys).toContain("No Thinking")
    expect(keys.join(" ")).not.toContain("Low Thinking")
  })

  it("keeps No Thinking when paired with thinking sibling", () => {
    const cfg = modelsToConfig([
      makeModel({ id: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5" }),
      makeModel({ id: "claude-sonnet-4-5-thinking", displayName: "Claude Sonnet 4.5 Thinking" }),
    ])
    expect(Object.keys(cfg["claude-sonnet-4-5"].variants).sort()).toEqual(["No Thinking", "Thinking"].sort())
  })

  it("sets reasoning true if any member supportsThinking or has effort variant", () => {
    const cfg = modelsToConfig([
      makeModel({ id: "claude-opus-5-low", displayName: "Claude Opus 5 Low", supportsThinking: false }),
      makeModel({ id: "claude-opus-5-medium", displayName: "Claude Opus 5 Medium", supportsThinking: false }),
    ])
    expect(cfg["claude-opus-5"].reasoning).toBe(true)
  })

  it("preserves flat model when single member without variant", () => {
    const cfg = modelsToConfig([makeModel({ id: "swe-1-6-slow", displayName: "SWE-1.6 Slow" })])
    // single without variant phrase -> flat id preserved if no grouping, or grouped as single base
    expect(Object.keys(cfg).length).toBe(1)
    const entry = Object.values(cfg)[0] as any
    expect(entry.name).toBeDefined()
  })

  it("handles opaque PRIVATE ids via alias and still synthesizes", () => {
    const cfg = modelsToConfig([
      makeModel({ id: "MODEL_PRIVATE_2", displayName: "Claude Sonnet 4.5" }),
      makeModel({ id: "MODEL_PRIVATE_3", displayName: "Claude Sonnet 4.5 Thinking" }),
    ])
    const variants = cfg["claude-sonnet-4-5"].variants as Record<string, any>
    expect(variants["No Thinking"]).toBeDefined()
    expect(variants["Thinking"]).toBeDefined()
    // wire resolution via alias
    const noThinkingParams = variants["No Thinking"].devinVariantParameters
    const thinkingParams = variants["Thinking"].devinVariantParameters
    expect(resolveDevinWireModelId({ devinVariantParameters: noThinkingParams }, "claude-sonnet-4-5")).toBe("MODEL_PRIVATE_2")
    expect(resolveDevinWireModelId({ devinVariantParameters: thinkingParams }, "claude-sonnet-4-5")).toBe("MODEL_PRIVATE_3")
  })

  it("normalizes Xhigh to XHigh in variant labels", () => {
    const cfg = modelsToConfig([makeModel({ id: "op-xhigh", displayName: "Opus Xhigh" }), makeModel({ id: "op-xhigh-fast", displayName: "Opus Xhigh Fast" })])
    expect(Object.keys(cfg["opus"].variants)).toContain("XHigh")
    expect(Object.keys(cfg["opus"].variants)).toContain("XHigh Fast")
  })

  it("uses id suffix fallback when displayName empty", () => {
    const cfg = modelsToConfig([makeModel({ id: "swe-1-7-max-fast", displayName: "" })])
    expect(cfg["swe-1-7"]).toBeDefined()
    expect(Object.keys(cfg["swe-1-7"].variants)).toContain("Max Fast")
  })

  it("derives slug from display label, not wire id, when they disagree", () => {
    const cfg = modelsToConfig([makeModel({ id: "swe-1-7-max-priority", displayName: "SWE-1.7 Max Fast" })])
    // display says Fast, id says priority — display wins
    expect(cfg["swe-1-7"]).toBeDefined()
    const params = (cfg["swe-1-7"].variants["Max Fast"] as any).devinVariantParameters
    expect(params).toEqual(expect.arrayContaining([{ id: "effort", value: "max" }, { id: "fast", value: "true" }]))
  })
})
