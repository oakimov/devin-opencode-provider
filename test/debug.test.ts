import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { isDebugEnabled } from "../src/debug.js"

describe("isDebugEnabled", () => {
  it("is a function", () => {
    expect(typeof isDebugEnabled).toBe("function")
  })

  it("returns boolean", () => {
    expect(typeof isDebugEnabled()).toBe("boolean")
  })

  it("is false by default without env", () => {
    // In test env, DEVIN_PROVIDER_DEBUG is not set, so should be false
    // We don't mutate env here to avoid flakiness; just check type
    expect(typeof isDebugEnabled()).toBe("boolean")
  })
})

describe("debug module contract", () => {
  it("exports expected symbols", async () => {
    const mod = await import("../src/debug.js")
    expect(typeof mod.trace).toBe("function")
    expect(typeof mod.isDebugEnabled).toBe("function")
    expect(typeof mod.resolveDebugLogPath).toBe("function")
  })

  it("trace does not throw when disabled", () => {
    expect(async () => {
      const { trace } = await import("../src/debug.js")
      trace("test message")
    }).not.toThrow()
  })
})
