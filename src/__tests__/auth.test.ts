import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { decodeJwtPayload, isExpiringSoon, decodeJwtExpiryMs, generatePkceParams, generatePkceChallenge, buildDevinLoginUrl, exchangeDevinCode, createLoopbackServer } from "../auth.js"

describe("Auth", () => {
  describe("JWT handling", () => {
    it("should decode valid JWT payload", () => {
      const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
      const payload = decodeJwtPayload(jwt)
      expect(payload).not.toBeNull()
      expect(payload?.sub).toBe("1234567890")
    })

    it("should return null for invalid JWT", () => {
      const payload = decodeJwtPayload("invalid.jwt.token")
      expect(payload).toBeNull()
    })

    it("should detect expiring JWTs", () => {
      const futureJwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE5MDAwMDAwMDB9.test"
      expect(isExpiringSoon(futureJwt, 1000000)).toBe(false)
    })

    it("should detect expired JWTs", () => {
      const pastJwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE2MDAwMDAwMDB9.test"
      expect(isExpiringSoon(pastJwt, 100000000)).toBe(true)
    })

    it("should extract expiry timestamp", () => {
      const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE2MDAwMDAwMDB9.test"
      const expiry = decodeJwtExpiryMs(jwt)
      expect(expiry).toBe(1600000000000)
    })
  })

  describe("PKCE flow", () => {
    it("should generate valid PKCE params", () => {
      const params = generatePkceParams()
      expect(params.verifier).toBeDefined()
      expect(params.uuid).toBeDefined()
      expect(params.verifier.length).toBeGreaterThan(20)
    })

    it("should generate PKCE challenge", async () => {
      const params = generatePkceParams()
      const challenge = await generatePkceChallenge(params.verifier)
      expect(challenge).toBeDefined()
      expect(challenge.length).toBeGreaterThan(0)
    })

    it("should build Devin login URL", () => {
      const params = generatePkceParams()
      const challenge = "test_challenge"
      const url = buildDevinLoginUrl({
        state: params.uuid,
        codeChallenge: challenge,
        redirectUri: "http://127.0.0.1:3000/callback",
      })
      expect(url).toContain("app.devin.ai")
      expect(url).toContain("code_challenge")
      expect(url).toContain("state")
    })
  })

  describe("Loopback server", () => {
    let server: Awaited<ReturnType<typeof createLoopbackServer>>

    afterEach(async () => {
      if (server) server.close()
    })

    it("should create loopback server", async () => {
      server = await createLoopbackServer()
      expect(server.port).toBeGreaterThan(0)
      expect(typeof server.close).toBe("function")
    })

    it("should handle callback with code", async () => {
      server = await createLoopbackServer()
      const state = "test_state"
      const code = "test_code"
      // Simulate the browser redirect by fetching the callback URL
      const fetchPromise = fetch(`http://127.0.0.1:${server.port}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`).then(r => r.text())
      const result = await server.waitForCode(state)
      expect(result).toBe(code)
      await fetchPromise
    })
  })
})