import { describe, it, expect, afterEach } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readStoredAuth } from "../src/context/auth-store.js"
import { opencodeGlobalDataDir } from "../src/context/paths.js"

describe("readStoredAuth", () => {
  it("returns undefined when auth file missing", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "devin-auth-store-"))
    const prev = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = tmp
    try {
      const res = await readStoredAuth("devin")
      expect(res).toBeUndefined()
    } finally {
      if (prev === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = prev
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })

  it("returns undefined for unknown provider id even when file exists", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "devin-auth-store-"))
    const prev = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = tmp
    try {
      await fs.mkdir(opencodeGlobalDataDir(), { recursive: true })
      await fs.writeFile(path.join(opencodeGlobalDataDir(), "auth.json"), JSON.stringify({ devin: { type: "api", key: "sk-test" } }))
      const res = await readStoredAuth("unknown-provider")
      expect(res).toBeUndefined()
    } finally {
      if (prev === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = prev
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })

  it("reads stored api auth", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "devin-auth-store-"))
    const prev = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = tmp
    try {
      await fs.mkdir(opencodeGlobalDataDir(), { recursive: true })
      await fs.writeFile(path.join(opencodeGlobalDataDir(), "auth.json"), JSON.stringify({ devin: { type: "api", key: "devin-session-token$abc" } }))
      const res: any = await readStoredAuth("devin")
      expect(res?.type).toBe("api")
      expect(res?.key).toContain("devin-session-token")
    } finally {
      if (prev === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = prev
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })

  it("handles malformed json gracefully", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "devin-auth-store-"))
    const prev = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = tmp
    try {
      await fs.mkdir(opencodeGlobalDataDir(), { recursive: true })
      await fs.writeFile(path.join(opencodeGlobalDataDir(), "auth.json"), "not json {")
      const res = await readStoredAuth("devin")
      expect(res).toBeUndefined()
    } finally {
      if (prev === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = prev
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })
})
