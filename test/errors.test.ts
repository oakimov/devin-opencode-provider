import { describe, it, expect } from "bun:test"
import { DevinProviderError, DevinAuthError, DevinTransportError } from "../src/errors.js"

describe("DevinProviderError", () => {
  it("carries code, transient, replaySafe, retryAfterMs, cause", () => {
    const cause = new Error("inner")
    const e = new DevinProviderError("msg", { code: "quota", transient: true, replaySafe: false, retryAfterMs: 1000, cause })
    expect(e.message).toBe("msg")
    expect(e.code).toBe("quota")
    expect(e.transient).toBe(true)
    expect(e.replaySafe).toBe(false)
    expect(e.retryAfterMs).toBe(1000)
    expect(e.cause).toBe(cause)
    expect(e.name).toBe("DevinProviderError")
  })

  it("defaults to undefined for optional fields", () => {
    const e = new DevinProviderError("x")
    expect(e.code).toBeUndefined()
    expect(e.transient).toBeUndefined()
  })
})

describe("DevinAuthError", () => {
  it("is not transient and has correct name", () => {
    const e = new DevinAuthError("auth failed", { code: "401" })
    expect(e.transient).toBe(false)
    expect(e.name).toBe("DevinAuthError")
    expect(e).toBeInstanceOf(DevinProviderError)
  })
})

describe("DevinTransportError", () => {
  it("supports transient and replaySafe flags", () => {
    const e = new DevinTransportError("net", { transient: true, replaySafe: true, code: "ETIMEDOUT" })
    expect(e.transient).toBe(true)
    expect(e.replaySafe).toBe(true)
    expect(e.code).toBe("ETIMEDOUT")
  })
})
