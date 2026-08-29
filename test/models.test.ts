import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  normalizeModelCache,
  isCacheFresh,
  cacheFilePath,
  readCache,
  clearDevinWireIdAliases,
  registerDevinWireIdAlias,
  resolveDevinWireModelId,
  wireModelIdFromBaseAndParams,
  extractDevinVariantParameters,
} from "../src/models.js"
import { MODEL_CACHE_SCHEMA_VERSION, MODEL_CACHE_TTL_MS } from "../src/shared.js"
import type { ModelInfo } from "../src/models.js"

const tmpDirs: string[] = []
async function tmpDir() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "devin-models-"))
  tmpDirs.push(d)
  return d
}
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true })))
  clearDevinWireIdAliases()
})

describe("normalizeModelCache", () => {
  it("accepts valid cache shape", () => {
    const c = normalizeModelCache({ models: [{ id: "a", variants: [] }], fetchedAt: Date.now() })
    expect(c?.models[0].id).toBe("a")
  })

  it("rejects missing models array", () => {
    expect(normalizeModelCache({ fetchedAt: Date.now() } as any)).toBeNull()
  })

  it("rejects non-numeric fetchedAt", () => {
    expect(normalizeModelCache({ models: [], fetchedAt: "now" } as any)).toBeNull()
  })

  it("rejects invalid schemaVersion", () => {
    expect(normalizeModelCache({ models: [], fetchedAt: Date.now(), schemaVersion: -1 } as any)).toBeNull()
  })

  it("normalizes displayName aliases", () => {
    const c = normalizeModelCache({ models: [{ id: "x", display_name: "X", variants: [] } as any], fetchedAt: Date.now() })
    expect(c?.models[0].displayName).toBe("X")
  })

  it("rejects malformed variant parameter values", () => {
    expect(normalizeModelCache({ models: [{ id: "x", variants: [{ parameterValues: [{ id: "effort", value: true }] }] } as any], fetchedAt: Date.now() })).toBeNull()
  })
})

describe("isCacheFresh", () => {
  it("is fresh within TTL and correct schema", () => {
    expect(isCacheFresh({ models: [], fetchedAt: Date.now(), schemaVersion: MODEL_CACHE_SCHEMA_VERSION })).toBe(true)
  })

  it("is stale when expired", () => {
    expect(isCacheFresh({ models: [], fetchedAt: Date.now() - MODEL_CACHE_TTL_MS - 1, schemaVersion: MODEL_CACHE_SCHEMA_VERSION })).toBe(false)
  })

  it("is stale when schema mismatched", () => {
    expect(isCacheFresh({ models: [], fetchedAt: Date.now(), schemaVersion: 999 } as any)).toBe(false)
  })

  it("respects custom ttl", () => {
    const c = { models: [], fetchedAt: Date.now() - 1000, schemaVersion: MODEL_CACHE_SCHEMA_VERSION }
    expect(isCacheFresh(c, 500)).toBe(false)
    expect(isCacheFresh(c, 5000)).toBe(true)
  })
})

describe("cacheFilePath and readCache", () => {
  it("returns file path under cache dir", async () => {
    const dir = await tmpDir()
    expect(cacheFilePath(dir)).toBe(path.join(dir, "devin-models.json"))
  })

  it("returns null when cache missing", async () => {
    const dir = await tmpDir()
    expect(await readCache(dir)).toBeNull()
  })

  it("returns null on invalid json", async () => {
    const dir = await tmpDir()
    await fs.writeFile(cacheFilePath(dir), "not json")
    expect(await readCache(dir)).toBeNull()
  })
})

describe("wireModelIdFromBaseAndParams", () => {
  it("returns base when no params", () => {
    expect(wireModelIdFromBaseAndParams("claude-opus-5", undefined)).toBe("claude-opus-5")
    expect(wireModelIdFromBaseAndParams("claude-opus-5", [])).toBe("claude-opus-5")
  })

  it("appends effort", () => {
    expect(wireModelIdFromBaseAndParams("claude-opus-5", [{ id: "effort", value: "low" }])).toBe("claude-opus-5-low")
    expect(wireModelIdFromBaseAndParams("claude-opus-5", [{ id: "effort", value: "max" }])).toBe("claude-opus-5-max")
  })

  it("handles thinking true with effort", () => {
    expect(wireModelIdFromBaseAndParams("op", [{ id: "effort", value: "low" }, { id: "thinking", value: "true" }])).toBe("op-low-thinking")
  })

  it("omits suffix for thinking false (bare base)", () => {
    expect(wireModelIdFromBaseAndParams("op", [{ id: "thinking", value: "false" }])).toBe("op")
  })

  it("inserts lightning before effort", () => {
    expect(wireModelIdFromBaseAndParams("swe-1-7", [{ id: "lightning", value: "true" }, { id: "effort", value: "max" }])).toBe("swe-1-7-lightning-max")
    expect(wireModelIdFromBaseAndParams("swe-1-7", [{ id: "lightning", value: "true" }, { id: "effort", value: "medium" }])).toBe("swe-1-7-lightning-medium")
  })

  it("appends fast and priority after effort", () => {
    expect(wireModelIdFromBaseAndParams("op", [{ id: "effort", value: "max" }, { id: "fast", value: "true" }])).toBe("op-max-fast")
    expect(wireModelIdFromBaseAndParams("op", [{ id: "effort", value: "low" }, { id: "priority", value: "true" }])).toBe("op-low-priority")
  })

  it("keeps -1m tier at end", () => {
    expect(wireModelIdFromBaseAndParams("claude-opus-4-6-1m", [{ id: "thinking", value: "true" }])).toBe("claude-opus-4-6-thinking-1m")
    expect(wireModelIdFromBaseAndParams("claude-opus-4-6-1m", [{ id: "effort", value: "low" }])).toBe("claude-opus-4-6-low-1m")
  })

  it("handles underscore style ids", () => {
    expect(wireModelIdFromBaseAndParams("MODEL_PRIVATE_2", [{ id: "effort", value: "low" }])).toContain("MODEL_PRIVATE_2")
  })

  it("falls back to variant param", () => {
    expect(wireModelIdFromBaseAndParams("op", [{ id: "variant", value: "custom" }])).toBe("op-custom")
  })
})

describe("resolveDevinWireModelId alias", () => {
  it("prefers explicit devinModelId override", () => {
    expect(resolveDevinWireModelId({ devinModelId: "explicit-id" }, "base")).toBe("explicit-id")
  })

  it("uses alias table when registered", () => {
    registerDevinWireIdAlias("claude-sonnet-4-5", [{ id: "thinking", value: "true" }], "MODEL_PRIVATE_3")
    expect(resolveDevinWireModelId({ devinVariantParameters: [{ id: "thinking", value: "true" }] }, "claude-sonnet-4-5")).toBe("MODEL_PRIVATE_3")
  })

  it("falls back to synthesis when no alias", () => {
    expect(resolveDevinWireModelId({ devinVariantParameters: [{ id: "effort", value: "low" }] }, "op")).toBe("op-low")
  })

  it("handles undefined providerOptions", () => {
    expect(resolveDevinWireModelId(undefined, "base")).toBe("base")
  })

  it("alias key is order independent", () => {
    registerDevinWireIdAlias("op", [{ id: "effort", value: "low" }, { id: "fast", value: "true" }], "op-low-fast")
    expect(resolveDevinWireModelId({ devinVariantParameters: [{ id: "fast", value: "true" }, { id: "effort", value: "low" }] }, "op")).toBe("op-low-fast")
  })
})

describe("extractDevinVariantParameters", () => {
  it("returns undefined when missing", () => {
    expect(extractDevinVariantParameters(undefined)).toBeUndefined()
    expect(extractDevinVariantParameters({})).toBeUndefined()
  })

  it("returns normalized params", () => {
    expect(extractDevinVariantParameters({ devinVariantParameters: [{ id: "effort", value: "low" }] })).toEqual([{ id: "effort", value: "low" }])
  })

  it("throws on malformed", () => {
    expect(() => extractDevinVariantParameters({ devinVariantParameters: [{ id: "effort", value: true as any }] })).toThrow()
  })
})
