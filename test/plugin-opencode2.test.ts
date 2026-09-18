import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../src/plugin-opencode2.js"
import { DevinPlugin } from "../src/plugin.js"
import { applyDevinProviderInventory, DEVIN_AISDK_PACKAGE, OPENCODE2_CATALOG_RELEASED_BASE_MS } from "../src/opencode2/catalog.js"
import { clearCompactionSessions, isCompactionSession } from "../src/compaction-marker.js"
import { clearSessionDirectories, getSessionDirectory } from "../src/session-directory.js"
import { registerDevinShellCall, resetDevinShellCalls } from "../src/shell-timeout.js"
import { getSessionTodos, setSessionTodos } from "../src/todo-store.js"
import { setHostCacheDirOverride } from "../src/context/paths.js"
import { writeCacheDirect } from "../src/models.js"
import { DEVIN_COMPACTION_OPTION, MODEL_CACHE_SCHEMA_VERSION } from "../src/shared.js"
import type { ModelInfo2, ProviderEditor, ProviderInfo } from "../src/opencode2/types.js"
import type { ModelInfo } from "../src/models.js"

function fakeProviderEditor() {
  const providers = new Map<string, ProviderInfo>()
  const models = new Map<string, ModelInfo2>()
  const editor: ProviderEditor = {
    add(input) {
      providers.set(input.info.id, { ...input.info })
      for (const key of [...models.keys()]) {
        if (key.startsWith(`${input.info.id}/`)) models.delete(key)
      }
      for (const model of input.models) {
        models.set(`${input.info.id}/${model.id}`, { ...model, providerID: input.info.id })
      }
    },
    remove(providerID) {
      providers.delete(providerID)
      for (const key of [...models.keys()]) {
        if (key.startsWith(`${providerID}/`)) models.delete(key)
      }
    },
  }
  return { editor, providers, models }
}

const baseModel: ModelInfo = {
  id: "claude-4.5-sonnet",
  displayName: "Sonnet 4.5",
  supportsAgent: true,
  supportsThinking: false,
  supportsImages: true,
  maxContext: 200_000,
  variants: [],
}

let isolatedCache: string | undefined

beforeEach(() => {
  clearCompactionSessions()
  clearSessionDirectories()
  resetDevinShellCalls()
  isolatedCache = mkdtempSync(join(tmpdir(), "devin-oc2-isolated-"))
  setHostCacheDirOverride(isolatedCache)
})

afterEach(() => {
  setHostCacheDirOverride(undefined)
  if (isolatedCache) rmSync(isolatedCache, { recursive: true, force: true })
  isolatedCache = undefined
})

describe("opencode2 provider inventory", () => {
  test("skips registration while the inventory is empty", () => {
    const { editor, providers, models } = fakeProviderEditor()
    applyDevinProviderInventory(editor, [])
    expect(providers.size).toBe(0)
    expect(models.size).toBe(0)
  })

  test("registers the devin provider on the aisdk path with an integration link", () => {
    const { editor, providers } = fakeProviderEditor()
    applyDevinProviderInventory(editor, [baseModel])

    const provider = providers.get("devin")
    expect(provider).toBeDefined()
    expect(provider!.package).toBe(DEVIN_AISDK_PACKAGE)
    expect(provider!.package.startsWith("aisdk:")).toBe(true)
    expect(provider!.integrationID).toBe("devin")
    expect(provider!.activation).toBe("enabled")
  })

  test("maps a model into the 2.0 shape", () => {
    const { editor, models } = fakeProviderEditor()
    applyDevinProviderInventory(editor, [baseModel])

    const model = models.get("devin/claude-4.5-sonnet")
    expect(model).toBeDefined()
    expect(model!.name).toBe("Sonnet 4.5")
    expect(model!.modelID).toBe("claude-4.5-sonnet")
    expect(model!.capabilities.tools).toBe(true)
    expect(model!.capabilities.input).toEqual(["text", "image"])
    expect(model!.time.released).toBeGreaterThan(OPENCODE2_CATALOG_RELEASED_BASE_MS)
  })

  test("orders the catalog by release time so zero does not sink the picker", () => {
    const { editor, models } = fakeProviderEditor()
    applyDevinProviderInventory(editor, [
      baseModel,
      { ...baseModel, id: "other-model", displayName: "Other Model" },
    ])
    const first = models.get("devin/claude-4.5-sonnet")!.time.released
    const second = models.get("devin/other-model")!.time.released
    expect(first).toBeGreaterThan(0)
    expect(second).toBeGreaterThan(0)
    expect(first).not.toBe(second)
    expect(first).toBeGreaterThan(second)
  })

  test("clearWhenEmpty removes a provider the host can delete", () => {
    const { editor, providers, models } = fakeProviderEditor()
    applyDevinProviderInventory(editor, [baseModel])
    applyDevinProviderInventory(editor, [], undefined, { clearWhenEmpty: true })
    expect(providers.has("devin")).toBe(false)
    expect(models.size).toBe(0)
  })

  test("remove runs before add when replacing a non-empty inventory", () => {
    const order: string[] = []
    const editor: ProviderEditor = {
      add() { order.push("add") },
      remove(providerID) { order.push(`remove:${providerID}`) },
    }
    applyDevinProviderInventory(editor, [baseModel])
    expect(order).toEqual(["remove:devin", "add"])
  })

  test("clearWhenEmpty writes a disabled provider when remove is absent", () => {
    const added: Array<{ activation: string; modelCount: number }> = []
    const editor: ProviderEditor = {
      add(input) {
        added.push({ activation: input.info.activation, modelCount: input.models.length })
      },
    }
    applyDevinProviderInventory(editor, [], undefined, { clearWhenEmpty: true })
    expect(added).toEqual([{ activation: "disabled", modelCount: 0 }])
  })
})

describe("opencode2 plugin shape", () => {
  test("default export is a 2.0 plugin definition with a classic server", () => {
    expect(plugin.id).toBe("devin.provider")
    expect(typeof plugin.setup).toBe("function")
    expect(plugin.server).toBe(DevinPlugin)
  })
})

function fakeContext(events: readonly unknown[] = [], subscribe?: () => unknown) {
  const registered: string[] = []
  const disposed: string[] = []
  const hooks = new Map<string, (input: any) => any>()
  const transforms = new Map<string, (draft: any) => void>()
  const inventory = fakeProviderEditor()

  const registration = (label: string) => {
    registered.push(label)
    return { dispose: async () => void disposed.push(label) }
  }
  const hookDomain = (domain: string) => ({
    hook: async (name: string, callback: (input: any) => any) => {
      hooks.set(`${domain}.${name}`, callback)
      return registration(`${domain}.${name}`)
    },
  })
  const transformDomain = (domain: string) => ({
    transform: async (callback: (draft: any) => void) => {
      transforms.set(domain, callback)
      return registration(`${domain}.transform`)
    },
    reload: async () => {},
  })

  const ctx: any = {
    location: { directory: "/workspace" },
    options: {},
    aisdk: hookDomain("aisdk"),
    event: {
      subscribe: subscribe ?? (() => events.length
        ? (async function* () {
            for (const event of events) yield event
          })()
        : undefined),
    },
    integration: {
      ...transformDomain("integration"),
      connection: {
        active: async () => undefined,
        resolve: async () => undefined,
      },
    },
    session: {
      ...hookDomain("session"),
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        location: { directory: `/proj/${sessionID}` },
      }),
    },
    websearch: transformDomain("websearch"),
    shell: hookDomain("shell"),
    provider: {
      transform: async (callback: (editor: any) => void) => {
        transforms.set("provider", callback)
        return registration("provider.transform")
      },
      reload: async () => {
        transforms.get("provider")?.(inventory.editor)
      },
    },
  }
  ctx.tool = {
    hook: hookDomain("tool").hook,
    transform: transformDomain("tool").transform,
  }
  return { ctx, registered, disposed, hooks, transforms, inventory }
}

describe("opencode2 plugin setup", () => {
  test("does not write models into opencode.json", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "devin-oc2-cfg-"))
    const cacheDir = mkdtempSync(join(tmpdir(), "devin-oc2-cache-"))
    const previousConfigDir = process.env.OPENCODE_CONFIG_DIR
    process.env.OPENCODE_CONFIG_DIR = configDir
    setHostCacheDirOverride(cacheDir)
    const existing = '{ "plugin": ["example"] }\n'
    const path = join(configDir, "opencode.json")
    writeFileSync(path, existing)
    try {
      await writeCacheDirect(cacheDir, {
        models: [baseModel],
        fetchedAt: Date.now(),
        schemaVersion: MODEL_CACHE_SCHEMA_VERSION,
      })
      const { ctx } = fakeContext()
      const cleanup = await plugin.setup(ctx)
      expect(readFileSync(path, "utf8")).toBe(existing)
      await cleanup()
    } finally {
      setHostCacheDirOverride(undefined)
      if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previousConfigDir
      rmSync(configDir, { recursive: true, force: true })
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  test("registers every domain it needs and returns a cleanup", async () => {
    const { ctx, registered, transforms } = fakeContext()
    const cleanup = await plugin.setup(ctx)

    expect(registered).toContain("integration.transform")
    expect(registered).toContain("provider.transform")
    expect(registered).toContain("aisdk.sdk")
    expect(registered).toContain("aisdk.language")
    expect(registered).toContain("tool.transform")
    expect(registered).toContain("tool.execute.before")
    expect(registered).toContain("tool.execute.after")
    expect(registered).toContain("session.context")
    expect(registered).toContain("session.compaction")
    expect(registered).toContain("session.generate")
    expect(registered).toContain("session.title")
    expect(registered).toContain("shell.create.before")
    expect(registered).toContain("websearch.transform")
    expect(typeof cleanup).toBe("function")

    const tools: Array<{ name: string }> = []
    transforms.get("tool")!({ add: (tool: { name: string }) => tools.push(tool) })
    expect(tools).toEqual([])
    expect(tools.map((t) => t.name)).not.toContain("devin_image_save")
    expect(tools.map((t) => t.name)).not.toContain("custom_websearch")
  })

  test("session.context records compaction and the session directory", async () => {
    const { ctx, hooks } = fakeContext()
    await plugin.setup(ctx)
    const event: { sessionID: string; agent: string; options?: Record<string, unknown> } = {
      sessionID: "ses_1",
      agent: "compaction",
    }
    await hooks.get("session.context")!(event)
    expect(event.options?.[DEVIN_COMPACTION_OPTION]).toBe(true)
    expect(isCompactionSession("ses_1")).toBe(true)
    expect(getSessionDirectory("ses_1")).toBe("/proj/ses_1")
  })

  test("accepts id or callID for shell sanitization", async () => {
    const { ctx, hooks } = fakeContext()
    await plugin.setup(ctx)
    const executionID = "devin_shell_id"
    registerDevinShellCall(executionID, {
      background_shell_spawn: true,
      command: "echo hello",
      working_directory: "/tmp",
    })
    const input = { command: "echo hello" }
    await hooks.get("tool.execute.before")!({
      tool: "shell",
      sessionID: "session",
      agent: "agent",
      messageID: "message",
      id: executionID,
      input,
    })
    const result = { output: "hello\n", metadata: {} }
    await hooks.get("tool.execute.after")!({
      tool: "shell",
      sessionID: "session",
      agent: "agent",
      messageID: "message",
      callID: executionID,
      input,
      status: "completed",
      result,
    })
    expect(typeof result.output).toBe("string")
  })

  test("cleanup disposes every registration", async () => {
    const { ctx, registered, disposed } = fakeContext()
    const cleanup = await plugin.setup(ctx)
    await (cleanup as () => Promise<void>)()
    expect(disposed.sort()).toEqual([...registered].sort())
  })

  test("the provider transform is a no-op until models are published", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "devin-oc2-plugin-empty-"))
    setHostCacheDirOverride(cacheDir)
    try {
      const { ctx, inventory } = fakeContext()
      await plugin.setup(ctx)
      expect(inventory.providers.size).toBe(0)
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  test("a transform replay with no models leaves an existing inventory in place", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "devin-oc2-plugin-keep-"))
    setHostCacheDirOverride(cacheDir)
    try {
      const { ctx, inventory } = fakeContext()
      const kept: ModelInfo2 = {
        id: "keep-me",
        modelID: "keep-me",
        providerID: "devin",
        name: "Keep",
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        variants: [],
        time: { released: 0 },
        cost: [],
        status: "active",
        enabled: true,
        limit: { context: 1, output: 1 },
      }
      inventory.editor.add({
        info: { id: "devin", name: "Devin", package: "aisdk:keep", activation: "enabled" },
        models: [kept],
      })
      const cleanup = await plugin.setup(ctx)
      await ctx.provider.reload()
      expect(inventory.models.get("devin/keep-me")?.name).toBe("Keep")
      expect(inventory.providers.get("devin")?.package).toBe("aisdk:keep")
      await cleanup()
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  test("the aisdk language hook resolves the wire model id", async () => {
    const { ctx, hooks } = fakeContext()
    await plugin.setup(ctx)
    const asked: string[] = []
    const event: any = {
      model: { providerID: "devin", id: "sonnet-1m", modelID: "sonnet" },
      sdk: {
        languageModel: (id: string) => {
          asked.push(id)
          return { id }
        },
      },
      options: {},
    }
    await hooks.get("aisdk.language")!(event)
    expect(asked).toEqual(["sonnet"])
    expect(event.language).toEqual({ id: "sonnet" })
  })

  test("cache seed publishes the in-memory inventory", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "devin-oc2-seed-"))
    setHostCacheDirOverride(cacheDir)
    try {
      await writeCacheDirect(cacheDir, {
        models: [baseModel],
        fetchedAt: Date.now(),
        schemaVersion: MODEL_CACHE_SCHEMA_VERSION,
      })
      const { ctx, inventory } = fakeContext()
      await plugin.setup(ctx)
      expect(inventory.providers.get("devin")?.package.startsWith("aisdk:")).toBe(true)
      expect(inventory.models.get("devin/claude-4.5-sonnet")?.name).toBe("Sonnet 4.5")
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  test("a failed credential switch drops the previous inventory", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "devin-oc2-switch-"))
    setHostCacheDirOverride(cacheDir)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let sent = false
    const stream = {
      async next() {
        await gate
        if (sent) return { done: true as const, value: undefined }
        sent = true
        return {
          done: false as const,
          value: { type: "credential.switched", integrationID: "devin" },
        }
      },
      return() {
        sent = true
        release()
        return { done: true as const, value: undefined }
      },
    }
    try {
      await writeCacheDirect(cacheDir, {
        models: [baseModel],
        fetchedAt: Date.now(),
        schemaVersion: MODEL_CACHE_SCHEMA_VERSION,
      })
      const { ctx, inventory } = fakeContext([], () => stream)
      const cleanup = await plugin.setup(ctx)
      expect(inventory.models.has("devin/claude-4.5-sonnet")).toBe(true)
      release()
      for (let i = 0; i < 30; i++) await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(inventory.providers.has("devin")).toBe(false)
      expect(inventory.models.has("devin/claude-4.5-sonnet")).toBe(false)
      await cleanup()
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  test("an in-flight token lookup is not reused after a credential switch", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "devin-oc2-token-"))
    setHostCacheDirOverride(cacheDir)
    let releaseToken!: (credential: { type: "key"; key: string }) => void
    const firstCredential = new Promise<{ type: "key"; key: string }>((resolve) => {
      releaseToken = resolve
    })
    let releaseEvent!: () => void
    const eventGate = new Promise<void>((resolve) => {
      releaseEvent = resolve
    })
    let sent = false
    const stream = {
      async next() {
        await eventGate
        if (sent) return { done: true as const, value: undefined }
        sent = true
        return {
          done: false as const,
          value: { type: "credential.switched", integrationID: "devin" },
        }
      },
      return() {
        sent = true
        releaseEvent()
        return { done: true as const, value: undefined }
      },
    }
    let resolveCalls = 0
    const previousFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error("offline")
    }) as typeof fetch
    let cleanup: (() => Promise<void>) | undefined
    try {
      await writeCacheDirect(cacheDir, {
        models: [baseModel],
        fetchedAt: Date.now(),
        schemaVersion: MODEL_CACHE_SCHEMA_VERSION,
      })
      const { ctx, hooks, inventory } = fakeContext([], () => stream)
      ctx.integration.connection = {
        active: async () => ({ type: "credential" as const, id: "devin", label: "Devin" }),
        resolve: async () => {
          resolveCalls++
          if (resolveCalls === 1) return firstCredential
          return { type: "key" as const, key: "new-token" }
        },
      }
      cleanup = await plugin.setup(ctx)
      for (let i = 0; i < 30 && resolveCalls < 1; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      expect(resolveCalls).toBe(1)

      const sdk = hooks.get("aisdk.sdk")!
      const firstLookup = sdk({
        model: { providerID: "devin", id: "sonnet", modelID: "sonnet" },
        package: "aisdk:devin-opencode-provider",
        options: {},
      })
      expect(resolveCalls).toBe(1)

      releaseEvent()
      for (let i = 0; i < 30 && inventory.providers.has("devin"); i++) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      expect(inventory.providers.has("devin")).toBe(false)
      releaseToken({ type: "key", key: "old-token" })
      await firstLookup
      expect(resolveCalls).toBe(2)

      await sdk({
        model: { providerID: "devin", id: "sonnet", modelID: "sonnet" },
        package: "aisdk:devin-opencode-provider",
        options: {},
      })
      expect(resolveCalls).toBe(2)
    } finally {
      await cleanup?.()
      globalThis.fetch = previousFetch
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })

  test("cleanup closes the event stream and drops process-global session state", async () => {
    let stopped = false
    let releaseNext: (() => void) | undefined
    const stream = {
      async next() {
        if (stopped) return { done: true as const, value: undefined }
        await new Promise<void>((resolve) => {
          releaseNext = resolve
        })
        return { done: true as const, value: undefined }
      },
      return() {
        stopped = true
        releaseNext?.()
        return { done: true as const, value: undefined }
      },
    }
    setSessionTodos("ses_cleanup", [{ content: "keep" }])
    const { ctx, hooks } = fakeContext([], () => stream)
    const cleanup = await plugin.setup(ctx)
    await hooks.get("session.context")!({ sessionID: "ses_cleanup", agent: "compaction" })
    expect(isCompactionSession("ses_cleanup")).toBe(true)
    expect(getSessionDirectory("ses_cleanup")).toBe("/proj/ses_cleanup")
    expect(getSessionTodos("ses_cleanup")).toHaveLength(1)
    await cleanup()
    expect(stopped).toBe(true)
    expect(isCompactionSession("ses_cleanup")).toBe(false)
    expect(getSessionDirectory("ses_cleanup")).toBeUndefined()
    expect(getSessionTodos("ses_cleanup")).toEqual([])
  })

  test("shell after hook ignores frozen and non-object results", async () => {
    const { ctx, hooks } = fakeContext()
    const cleanup = await plugin.setup(ctx)
    const frozen = Object.freeze({ output: "hi" })
    await hooks.get("tool.execute.after")!({
      tool: "shell",
      sessionID: "session",
      agent: "agent",
      messageID: "message",
      id: "devin_frozen",
      status: "completed",
      result: frozen,
    })
    expect(frozen.output).toBe("hi")
    await hooks.get("tool.execute.after")!({
      tool: "shell",
      sessionID: "session",
      agent: "agent",
      messageID: "message",
      id: "devin_string",
      status: "completed",
      result: "not-an-object",
    })
    await cleanup()
  })
})
