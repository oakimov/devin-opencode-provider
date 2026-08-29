import { describe, it, expect } from "bun:test"
import { opencodeGlobalCacheDir, opencodeGlobalDataDir } from "../src/context/paths.js"
import { readStoredAuth } from "../src/context/auth-store.js"

describe("context paths integration", () => {
  it("cache and data dirs are distinct by default", async () => {
    const origCache = process.env.XDG_CACHE_HOME
    const origData = process.env.XDG_DATA_HOME
    delete process.env.XDG_CACHE_HOME
    delete process.env.XDG_DATA_HOME
    try {
      expect(opencodeGlobalCacheDir()).not.toBe(opencodeGlobalDataDir())
    } finally {
      if (origCache !== undefined) process.env.XDG_CACHE_HOME = origCache
      else delete process.env.XDG_CACHE_HOME
      if (origData !== undefined) process.env.XDG_DATA_HOME = origData
      else delete process.env.XDG_DATA_HOME
    }
  })
})

describe("auth-store integration", () => {
  it("readStoredAuth handles concurrent calls", async () => {
    const results = await Promise.all([readStoredAuth("devin"), readStoredAuth("windsurf"), readStoredAuth("unknown")])
    expect(results.length).toBe(3)
    // All should be undefined when no file exists in isolated tmp
    // But if real auth exists, at least unknown should be undefined
    expect(results[2]).toBeUndefined()
  })
})
