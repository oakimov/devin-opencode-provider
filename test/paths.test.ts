import { describe, it, expect, afterEach } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { opencodeGlobalCacheDir, opencodeGlobalDataDir } from "../src/context/paths.js"

describe("opencodeGlobalCacheDir", () => {
  const origCache = process.env.XDG_CACHE_HOME
  const origData = process.env.XDG_DATA_HOME
  afterEach(() => {
    if (origCache === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = origCache
    if (origData === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = origData
  })

  it("respects XDG_CACHE_HOME", () => {
    process.env.XDG_CACHE_HOME = "/tmp/custom-cache"
    expect(opencodeGlobalCacheDir()).toBe("/tmp/custom-cache/opencode")
  })

  it("falls back to ~/.cache/opencode", () => {
    delete process.env.XDG_CACHE_HOME
    const dir = opencodeGlobalCacheDir()
    expect(dir).toContain("opencode")
    expect(dir).toContain(".cache")
  })

  it("returns absolute path", () => {
    expect(path.isAbsolute(opencodeGlobalCacheDir())).toBe(true)
  })
})

describe("opencodeGlobalDataDir", () => {
  const orig = process.env.XDG_DATA_HOME
  afterEach(() => {
    if (orig === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = orig
  })

  it("respects XDG_DATA_HOME", () => {
    process.env.XDG_DATA_HOME = "/tmp/custom-data"
    expect(opencodeGlobalDataDir()).toBe("/tmp/custom-data/opencode")
  })

  it("falls back to ~/.local/share/opencode", () => {
    delete process.env.XDG_DATA_HOME
    const dir = opencodeGlobalDataDir()
    expect(dir).toContain("opencode")
  })

  it("is sibling to cache dir by default (different roots)", () => {
    delete process.env.XDG_CACHE_HOME
    delete process.env.XDG_DATA_HOME
    const cache = opencodeGlobalCacheDir()
    const data = opencodeGlobalDataDir()
    expect(cache).not.toBe(data)
  })
})
