import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DevinPlugin, loadClassicTools } from "../src/plugin.js"
import { openCodeWebSearchTool } from "../src/web-search-tool.js"
import { DEVIN_COMPACTION_OPTION, DEVIN_HOST_AGENT_OPTION } from "../src/shared.js"
import { DEVIN_TIMEOUT_BACKGROUND, registerDevinShellCall, resetDevinShellCalls } from "../src/shell-timeout.js"
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

describe("loadClassicTools", () => {
  function chain() {
    const node: Record<string, unknown> = {}
    for (const name of ["describe", "optional", "int", "min", "max", "positive"]) {
      node[name] = () => node
    }
    return node
  }

  it("uses a host tool factory only when the schema chain is real", async () => {
    const schema = {
      string: () => chain(),
      number: () => chain(),
      enum: () => chain(),
    }
    const tool = Object.assign((input: Record<string, unknown>) => input, { schema })
    const loaded = await loadClassicTools({
      configDirs: ["/no/such/opencode-config"],
      importModule: async () => ({ tool }),
    })
    expect(loaded.webSearch.description).toContain("Search the web")
    expect(loaded.webSearch).not.toBe(openCodeWebSearchTool)
  })

  it("falls back when the module shape is not a Zod factory", async () => {
    const loaded = await loadClassicTools({
      configDirs: ["/no/such/opencode-config"],
      importModule: async () => ({ tool: { schema: { string: "nope" } } }),
    })
    expect(loaded.webSearch).toBe(openCodeWebSearchTool)
  })

  it("falls back when the schema builders throw or omit the number chain", async () => {
    const throwing = {
      string: () => { throw new Error("not a zod string") },
      number: () => chain(),
      enum: () => chain(),
    }
    const missingInt = {
      string: () => chain(),
      number: () => ({ describe: () => ({}), optional: () => ({}) }),
      enum: () => chain(),
    }
    for (const schema of [throwing, missingInt]) {
      const tool = Object.assign((input: Record<string, unknown>) => input, { schema })
      const loaded = await loadClassicTools({
        configDirs: ["/no/such/opencode-config"],
        importModule: async () => ({ tool }),
      })
      expect(loaded.webSearch).toBe(openCodeWebSearchTool)
    }
  })

  it("accepts the factory on a default export", async () => {
    const schema = {
      string: () => chain(),
      number: () => chain(),
      enum: () => chain(),
    }
    const tool = Object.assign((input: Record<string, unknown>) => input, { schema })
    const loaded = await loadClassicTools({
      configDirs: ["/no/such/opencode-config"],
      importModule: async () => ({ default: { tool } }),
    })
    expect(loaded.webSearch.description).toContain("Search the web")
  })
})

describe("classic hook guards", () => {
  afterEach(() => {
    resetDevinShellCalls()
  })

  it("chat.params records compaction and skips frozen options", async () => {
    const plugin = await DevinPlugin({ directory: "/tmp", client: fakeClient(async () => undefined) } as any)
    const output = { options: {} as Record<string, unknown> }
    await plugin["chat.params"]!(
      { model: { providerID: "devin" }, agent: "compaction" },
      output,
    )
    expect(output.options[DEVIN_HOST_AGENT_OPTION]).toBe("compaction")
    expect(output.options[DEVIN_COMPACTION_OPTION]).toBe(true)

    const frozen = Object.freeze({ options: Object.freeze({}) })
    await plugin["chat.params"]!(
      { model: { providerID: "devin" }, agent: "compaction" },
      frozen,
    )
    expect(frozen.options).toEqual({})
  })

  it("tool.execute.before ignores frozen shell args", async () => {
    registerDevinShellCall("devin_frozen_args", {
      shell_stream: true,
      timeout_behavior: DEVIN_TIMEOUT_BACKGROUND,
      command: "echo hi",
      working_directory: "/tmp",
      timeout_ms: 1_000,
    })
    const plugin = await DevinPlugin({ directory: "/tmp", client: fakeClient(async () => undefined) } as any)
    const args = Object.freeze({})
    await plugin["tool.execute.before"]!(
      { tool: "bash", callID: "devin_frozen_args" },
      { args },
    )
    expect(args).toEqual({})
  })
})
