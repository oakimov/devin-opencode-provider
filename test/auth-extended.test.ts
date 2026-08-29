import { describe, it, expect } from "bun:test"
import { generatePkceParams, generatePkceChallenge, buildDevinLoginUrl, buildWindsurfLoginUrl, isExpiringSoon } from "../src/auth.js"

describe("PKCE extended", () => {
  it("generates unique verifiers", () => {
    const a = generatePkceParams()
    const b = generatePkceParams()
    expect(a.verifier).not.toBe(b.verifier)
    expect(a.uuid).not.toBe(b.uuid)
  })

  it("challenge is base64url without padding", async () => {
    const p = generatePkceParams()
    const c = await generatePkceChallenge(p.verifier)
    expect(c).not.toContain("+")
    expect(c).not.toContain("/")
    expect(c).not.toContain("=")
    expect(c.length).toBeGreaterThan(20)
  })

  it("same verifier produces same challenge", async () => {
    const verifier = "test-verifier-string-1234567890-abcdef"
    const c1 = await generatePkceChallenge(verifier)
    const c2 = await generatePkceChallenge(verifier)
    expect(c1).toBe(c2)
  })

  it("different verifiers produce different challenges", async () => {
    const c1 = await generatePkceChallenge("verifier-one-123456")
    const c2 = await generatePkceChallenge("verifier-two-123456")
    expect(c1).not.toBe(c2)
  })
})

describe("buildDevinLoginUrl", () => {
  it("contains required params", () => {
    const url = buildDevinLoginUrl({ state: "s1", codeChallenge: "ch", redirectUri: "http://localhost/cb" })
    expect(url).toContain("state=s1")
    expect(url).toContain("code_challenge=ch")
    expect(url).toContain("redirect_uri=")
    expect(url).toContain("code_challenge_method=S256")
  })

  it("uses custom websiteUrl when provided", () => {
    const url = buildDevinLoginUrl({ state: "s", codeChallenge: "c", redirectUri: "http://x", websiteUrl: "https://custom.example.com" })
    expect(url).toStartWith("https://custom.example.com")
  })

  it("encodes special characters in params", () => {
    const url = buildDevinLoginUrl({ state: "a/b c", codeChallenge: "ch+/", redirectUri: "http://localhost/cb?x=1" })
    expect(url).toContain("a%2Fb")
    expect(url).toContain("ch%2B%2F")
  })
})

describe("buildWindsurfLoginUrl", () => {
  it("contains expected query params", () => {
    const url = buildWindsurfLoginUrl("state1", 1234)
    expect(url).toContain("state=state1")
    expect(url).toContain("127.0.0.1%3A1234")
    expect(url).toContain("client_id=")
  })
})

describe("isExpiringSoon edge cases", () => {
  it("returns true for malformed jwt", () => {
    expect(isExpiringSoon("not-a-jwt", 300)).toBe(true)
    expect(isExpiringSoon("", 300)).toBe(true)
    expect(isExpiringSoon("a.b.c", 300)).toBe(true)
  })

  it("returns true for jwt without exp", () => {
    const payload = btoa(JSON.stringify({ sub: "x" }))
    const jwt = `h.${payload}.s`
    expect(isExpiringSoon(jwt, 300)).toBe(true)
  })

  it("returns false for jwt with far future exp", () => {
    const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 10000 }))
    const jwt = `h.${payload}.s`
    expect(isExpiringSoon(jwt, 300)).toBe(false)
  })
})
