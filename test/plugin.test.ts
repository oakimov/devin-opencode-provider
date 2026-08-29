import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DevinPlugin } from "../src/plugin.js"
import type { ModelInfo } from "../src/models.js"
import { MODEL_CACHE_FILE } from "../src/shared.js"

function fakeClient(authGet: () => Promise<any>) {
  return {
    auth: {
      get: authGet,
      set: async () => {},
    },
  } as any
}

describe("DevinPlugin config hook", () => {
  let tmpCache: string
  let origXdgCache: string | undefined
  let origXdgData: string | undefined

  beforeEach(async () => {
    tmpCache = await fs.mkdtemp(path.join(os.tmpdir(), "devin-plugin-"))
    origXdgCache = process.env.XDG_CACHE_HOME
    origXdgData = process.env.XDG_DATA_HOME
    process.env.XDG_CACHE_HOME = tmpCache
    process.env.XDG_DATA_HOME = tmpCache
  })

  afterEach(async () => {
    if (origXdgCache === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = origXdgCache
    if (origXdgData === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = origXdgData
    await fs.rm(tmpCache, { recursive: true, force: true })
  })

  it("installs devin provider when cfg.provider missing", async () => {
    const plugin = await DevinPlugin({ directory: "/tmp", client: fakeClient(async () => undefined) } as any)
    const cfg: any = {}
    await plugin.config!(cfg)
    expect(cfg.provider.devin).toBeDefined()
    expect(cfg.provider.devin.npm).toContain("index.js")
    expect(cfg.provider.devin.models).toBeDefined()
  })

  it("always overwrites existing models (no stale merge)", async () => {
    const plugin = await DevinPlugin({ directory: "/tmp", client: fakeClient(async () => undefined) } as any)
    const cfg: any = { provider: { devin: { models: { stale: { name: "Stale" } }, name: "Devin" } } }
    await plugin.config!(cfg)
    expect(cfg.provider.devin.models.stale).toBeUndefined()
  })

  it("loads cached models when cache fresh", async () => {
    const cacheDir = path.join(tmpCache, "opencode")
    await fs.mkdir(cacheDir, { recursive: true })
    const models: ModelInfo[] = [{ id: "swe-1-6-slow", displayName: "SWE-1.6 Slow", variants: [] }]
    await fs.writeFile(path.join(cacheDir, MODEL_CACHE_FILE), JSON.stringify({ models, fetchedAt: Date.now(), schemaVersion: 2 }))

    const plugin = await DevinPlugin({ directory: "/tmp", client: fakeClient(async () => undefined) } as any)
    const cfg: any = {}
    await plugin.config!(cfg)
    // swe-1-6-slow with display "SWE-1.6 Slow" groups to base "swe-1-6" with variant "Slow"
    const hasGrouped = cfg.provider.devin.models["swe-1-6"] !== undefined
    const hasFlat = cfg.provider.devin.models["swe-1-6-slow"] !== undefined
    expect(hasGrouped || hasFlat).toBe(true)
  })

  it("exposes auth provider devin with oauth and api methods", async () => {
    const plugin = await DevinPlugin({ directory: "/tmp", client: fakeClient(async () => undefined) } as any)
    expect((plugin.auth as any).provider).toBe("devin")
    expect((plugin.auth as any).methods.length).toBeGreaterThanOrEqual(2)
    expect((plugin.auth as any).methods.map((m: any) => m.type)).toContain("oauth")
    expect((plugin.auth as any).methods.map((m: any) => m.type)).toContain("api")
  })

  it("handles missing cache gracefully", async () => {
    const plugin = await DevinPlugin({ directory: "/tmp", client: fakeClient(async () => undefined) } as any)
    const cfg: any = {}
    await plugin.config!(cfg)
    expect(cfg.provider.devin.models).toBeDefined()
  })
})
