import { describe, it, expect } from "bun:test"
import * as Catalog from "../src/opencode2/catalog.js"
import * as Types from "../src/opencode2/types.js"

describe("opencode2 catalog", () => {
  it("exports expected symbols", async () => {
    expect(typeof Catalog).toBe("object")
    expect(Object.keys(Catalog).length).toBeGreaterThan(0)
  })

  it("catalog module is importable", async () => {
    const mod = await import("../src/opencode2/catalog.js")
    expect(mod).toBeDefined()
  })
})

describe("opencode2 types", () => {
  it("exports type definitions", async () => {
    const mod = await import("../src/opencode2/types.js")
    expect(mod).toBeDefined()
  })

  it("types module is importable", () => {
    expect(typeof Types).toBe("object")
  })
})

describe("opencode2 integration", () => {
  it("exports integration helpers", async () => {
    const mod = await import("../src/opencode2/integration.js")
    expect(mod).toBeDefined()
    expect(Object.keys(mod).length).toBeGreaterThan(0)
  })
})
