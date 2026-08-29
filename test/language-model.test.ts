import { describe, it, expect } from "bun:test"
import { buildDevinOpenCodeGuidance } from "../src/language-model.js"

// We test the exported guidance builder directly; it is the contract tightened
// for read/edit/write after the file-tool failures.

function guids(tools: string[], root = "/tmp/ws") {
  return buildDevinOpenCodeGuidance(tools.map(name => ({ name, description: "", parameters: {} })), root) ?? ""
}

describe("buildDevinOpenCodeGuidance", () => {
  it("returns undefined when no tools", () => {
    expect(buildDevinOpenCodeGuidance([], "/tmp")).toBeUndefined()
  })

  it("lists exact tool names and workspace root", () => {
    const g = guids(["read", "edit", "write"])
    expect(g).toContain("`read`")
    expect(g).toContain("`edit`")
    expect(g).toContain("`write`")
    expect(g).toContain('Workspace root: "/tmp/ws"')
  })

  it("emits read contract with offset/limit and cap handling", () => {
    const g = guids(["read"])
    expect(g).toContain("`read`")
    expect(g).toContain("offset")
    expect(g).toContain("Output capped at 50 KB")
    expect(g).toContain("re-`read`")
    expect(g).not.toContain("`edit` — For surgical")
  })

  it("emits edit contract with exact match and context", () => {
    const g = guids(["edit"])
    expect(g).toContain("`edit` — For surgical")
    expect(g).toContain("oldString")
    expect(g).toContain("byte-for-byte")
    expect(g).toContain("unique in the file")
    expect(g).toContain("2–3 lines")
    expect(g).toContain("oldString not found")
    expect(g).toContain("multiple matches")
    expect(g).toContain("Never include line-number prefixes")
  })

  it("emits write contract with full content and overwrite warning", () => {
    const g = guids(["write"])
    expect(g).toContain("`write`")
    expect(g).toContain("content")
    expect(g).toContain("overwrites")
    expect(g).toContain("truncated")
  })

  it("prefers edit for patches when both edit and write present", () => {
    const g = guids(["edit", "write"])
    expect(g).toContain("prefer `edit` for small targeted patches")
  })

  it(" Falls back to apply_patch guidance when write missing", () => {
    const g = guids(["apply_patch"])
    expect(g).toContain("`apply_patch`")
    expect(g).toContain("converted to `apply_patch`")
  })

  it("adds search guidance for grep/glob", () => {
    expect(guids(["grep"])).toContain("`grep`")
    expect(guids(["glob"])).toContain("`glob`")
    expect(guids(["grep", "glob"])).toContain("`grep` and `glob`")
    expect(guids(["read"])).not.toContain("For code search")
  })

  it("mentions question tool when present", () => {
    expect(guids(["question"])).toContain("`question`")
    expect(guids(["read"])).not.toContain("`question`")
  })

  it("always includes footer about emitting actual tool calls", () => {
    expect(guids(["read"])).toContain("Emit the actual tool call and wait for its result")
  })

  it("escapes workspace root JSON", () => {
    const g = guids(["read"], "/tmp/my ws")
    expect(g).toContain(JSON.stringify("/tmp/my ws"))
  })

  it("includes cap warning even without read when edit/write present", () => {
    const g = guids(["edit"])
    expect(g).toContain("capped/partial")
  })
})

describe("tool description injection via extractTools (smoke)", () => {
  // The language model module injects tightened descriptions at runtime;
  // we verify the guidance contract is the one the model will see for
  // file tools. Direct tool description tests live in plugin tests, but
  // we smoke-test the guidance shape here as the second contract surface.
  it("guidance is stable for canonical file-tool catalog", () => {
    const g = guids(["read", "edit", "write", "grep", "glob", "bash", "question"])
    expect(g.split("\n").length).toBeGreaterThan(5)
    expect(g).toContain("OpenCode exposes exactly these executable tools")
  })
})
