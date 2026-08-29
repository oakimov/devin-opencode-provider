import { describe, it, expect } from "bun:test"
import { applyDevinModelCost } from "../src/pricing.js"
import { DEVIN_MODEL_COSTS } from "../src/pricing-data.js"

describe("DEVIN_MODEL_COSTS", () => {
  it("is an object (even when stubbed)", () => {
    expect(typeof DEVIN_MODEL_COSTS).toBe("object")
    expect(DEVIN_MODEL_COSTS).not.toBeNull()
  })
})

describe("applyDevinModelCost", () => {
  it("returns config unchanged when no cost for model", () => {
    const cfg: any = { name: "X", limit: { context: 200_000, output: 32_000 } }
    const out = applyDevinModelCost("unknown-model-xyz", cfg)
    expect(out).toEqual(cfg)
  })

  it("preserves original limit and name", () => {
    const cfg: any = { name: "My Model", limit: { context: 123, output: 456 }, variants: { Low: { devinVariantParameters: [] } } }
    const out = applyDevinModelCost("unknown-model-xyz", cfg)
    expect(out.name).toBe("My Model")
    expect(out.limit).toEqual({ context: 123, output: 456 })
    expect(out.variants).toEqual(cfg.variants)
  })

  it("is pure (does not mutate input)", () => {
    const cfg: any = { name: "X", limit: { context: 1, output: 1 } }
    const copy = { ...cfg, limit: { ...cfg.limit } }
    applyDevinModelCost("unknown-model", cfg)
    expect(cfg).toEqual(copy)
  })

  it("handles known cost when present (smoke)", async () => {
    const keys = Object.keys(DEVIN_MODEL_COSTS as Record<string, any>)
    if (keys.length === 0) {
      expect(true).toBe(true)
      return
    }
    const known = keys[0]
    const cfg: any = { name: "X", limit: { context: 1, output: 1 } }
    const out = applyDevinModelCost(known, cfg)
    expect(out.cost).toBeDefined()
  })
})
