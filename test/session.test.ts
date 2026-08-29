import { describe, it, expect } from "bun:test"
import * as Session from "../src/session.js"

describe("session module", () => {
  it("exports expected symbols", () => {
    expect(typeof Session).toBe("object")
    expect(Object.keys(Session).length).toBeGreaterThan(0)
  })

  it("is importable without side effects", async () => {
    const mod = await import("../src/session.js")
    expect(mod).toBeDefined()
  })
})
