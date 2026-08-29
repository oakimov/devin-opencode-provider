import { describe, it, expect } from "bun:test"
import * as Shared from "../src/shared.js"

describe("shared constants", () => {
  it("exports expected hosts", () => {
    expect(Shared.WINDSURF_API_HOST).toBe("server.codeium.com")
    expect(Shared.DEVIN_API_HOST).toBe("api.devin.ai")
    expect(Shared.DEVIN_WEBSITE_HOST).toBe("app.devin.ai")
  })

  it("exports provider ids", () => {
    expect(Shared.DEVIN_PROVIDER_ID).toBe("devin")
    expect(Shared.WINDSURF_PROVIDER_ID).toBe("windsurf")
    expect(Shared.PRIMARY_PROVIDER_ID).toBe("devin")
  })

  it("exports cache file constants", () => {
    expect(Shared.MODEL_CACHE_FILE).toBe("devin-models.json")
    expect(Shared.MODEL_CACHE_SCHEMA_VERSION).toBe(3)
    expect(Shared.MODEL_CACHE_TTL_MS).toBe(86_400_000)
  })

  it("exports api paths", () => {
    expect(Shared.USER_JWT_PATH).toContain("GetUserJwt")
    expect(Shared.USER_STATUS_PATH).toContain("GetUserStatus")
  })

  it("exports fallback version", () => {
    expect(typeof Shared.FALLBACK_CLIENT_VERSION).toBe("string")
    expect(Shared.FALLBACK_CLIENT_VERSION.length).toBeGreaterThan(0)
  })
})
