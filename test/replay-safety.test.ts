import { describe, it, expect } from "bun:test"
import * as Replay from "../src/replay-safety.js"

describe("replay-safety module", () => {
  it("exports expected symbols", () => {
    expect(typeof Replay).toBe("object")
    expect(Object.keys(Replay).length).toBeGreaterThan(0)
  })

  it("is importable", async () => {
    const mod = await import("../src/replay-safety.js")
    expect(mod).toBeDefined()
  })
})
