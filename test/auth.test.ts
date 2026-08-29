import { describe, it, expect } from "bun:test"
import { isExpiringSoon, decodeJwtPayload, decodeJwtExpiryMs } from "../src/auth.js"

describe("auth", () => {
  describe("isExpiringSoon", () => {
    it("returns true for expired JWT", () => {
      const expiredJwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE2MDAwMDAwMDB9.invalid"
      expect(isExpiringSoon(expiredJwt, 1000000)).toBe(true)
    })

    it("returns false for fresh JWT", () => {
      const futureTime = Math.floor(Date.now() / 1000) + 3600
      const payload = btoa(JSON.stringify({ exp: futureTime }))
      const freshJwt = `header.${payload}.signature`
      expect(isExpiringSoon(freshJwt, 300)).toBe(false)
    })

    it("returns true for JWT expiring within threshold", () => {
      const nearFuture = Math.floor(Date.now() / 1000) + 200
      const payload = btoa(JSON.stringify({ exp: nearFuture }))
 const nearExpiryJwt = `header.${payload}.signature`
      expect(isExpiringSoon(nearExpiryJwt, 300)).toBe(true)
    })
  })

  describe("decodeJwtPayload", () => {
    it("decodes valid JWT payload", () => {
      const payload = { exp: 1234567890, sub: "test" }
      const encoded = btoa(JSON.stringify(payload))
      const jwt = `header.${encoded}.signature`
      const decoded = decodeJwtPayload(jwt)
      expect(decoded).toEqual(payload)
    })

    it("returns null for invalid JWT format", () => {
      expect(decodeJwtPayload("invalid")).toBe(null)
      expect(decodeJwtPayload("only.two")).toBe(null)
    })

    it("returns null for non-JSON payload", () => {
      const jwt = `header.${btoa("not-json")}.signature`
      expect(decodeJwtPayload(jwt)).toBe(null)
    })

    it("returns null for array payload", () => {
      const jwt = `header.${btoa(JSON.stringify([1, 2, 3]))}.signature`
      expect(decodeJwtPayload(jwt)).toBe(null)
    })
  })

  describe("decodeJwtExpiryMs", () => {
    it("returns expiry time in milliseconds", () => {
      const exp = 1234567890
      const payload = { exp }
      const jwt = `header.${btoa(JSON.stringify(payload))}.signature`
      const expiryMs = decodeJwtExpiryMs(jwt)
      expect(expiryMs).toBe(exp * 1000)
    })

    it("returns null for missing exp field", () => {
      const payload = { sub: "test" }
      const jwt = `header.${btoa(JSON.stringify(payload))}.signature`
      expect(decodeJwtExpiryMs(jwt)).toBe(null)
    })

    it("returns null for non-numeric exp", () => {
      const payload = { exp: "invalid" }
      const jwt = `header.${btoa(JSON.stringify(payload))}.signature`
      expect(decodeJwtExpiryMs(jwt)).toBe(null)
    })
  })
})