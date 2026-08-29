import { describe, it, expect } from "bun:test"

describe("plugin-v2 module", () => {
  it("is importable", async () => {
    const mod = await import("../src/plugin-v2.js")
    expect(mod).toBeDefined()
  })

  it("exports expected symbols", async () => {
    const mod = await import("../src/plugin-v2.js")
    expect(Object.keys(mod).length).toBeGreaterThan(0)
  })
})

describe("plugin-opencode2 module", () => {
  it("is importable", async () => {
    const mod = await import("../src/plugin-opencode2.js")
    expect(mod).toBeDefined()
  })
})
