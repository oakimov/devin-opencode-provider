import { describe, it, expect } from "bun:test"
import { buildAddFilePatch, buildUpdateFilePatch, planSubstringEdit } from "../src/protocol/apply-patch.js"

describe("buildAddFilePatch", () => {
  it("creates patch with header and lines", () => {
    const p = buildAddFilePatch("a/b.txt", "hello\nworld")
    expect(p).toContain("*** Begin Patch")
    expect(p).toContain("*** Add File: a/b.txt")
    expect(p).toContain("+hello")
    expect(p).toContain("+world")
    expect(p).toContain("*** End Patch")
  })

  it("handles empty content", () => {
    const p = buildAddFilePatch("empty.txt", "")
    expect(p).toContain("*** Add File: empty.txt")
    expect(p).toContain("*** End Patch")
  })

  it("handles trailing newline", () => {
    const p = buildAddFilePatch("f.txt", "a\nb\n")
    expect(p).toContain("+a")
    expect(p).toContain("+b")
  })
})

describe("buildUpdateFilePatch", () => {
  it("builds update patch with chunks", () => {
    const p = buildUpdateFilePatch("src/x.ts", [{ oldLines: ["old"], newLines: ["new"] }])
    expect(p).toContain("*** Update File: src/x.ts")
    expect(p).toContain("@@")
    expect(p).toContain("-old")
    expect(p).toContain("+new")
  })

  it("handles multiple chunks", () => {
    const p = buildUpdateFilePatch("f.txt", [
      { oldLines: ["a"], newLines: ["b"] },
      { oldLines: ["c"], newLines: ["d"] },
    ])
    expect((p.match(/@@/g) || []).length).toBe(2)
  })

  it("handles empty chunks gracefully", () => {
    const p = buildUpdateFilePatch("f.txt", [])
    expect(p).toContain("*** Begin Patch")
    expect(p).toContain("*** End Patch")
  })
})

describe("planSubstringEdit", () => {
  it("plans single occurrence", () => {
    const src = "hello world"
    const res = planSubstringEdit(src, "world", "there")
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.chunks.length).toBe(1)
  })

  it("fails on empty oldString", () => {
    const res = planSubstringEdit("x", "", "y")
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/empty/i)
  })

  it("fails on missing oldString", () => {
    const res = planSubstringEdit("hello", "missing", "x")
    expect(res.ok).toBe(false)
  })

  it("fails on multiple matches without replaceAll", () => {
    const res = planSubstringEdit("a a a", "a", "b")
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/unique|appears/i)
  })

  it("succeeds on multiple matches with replaceAll on separate lines", () => {
    const src = "foo TARGET bar\nother\nfoo TARGET bar\nother\nfoo TARGET bar"
    const res = planSubstringEdit(src, "TARGET", "REPLACED", true)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.chunks.length).toBe(3)
  })

  it("preserves surrounding context in chunks", () => {
    const src = "line1\nline2 target line3\nline4"
    const res = planSubstringEdit(src, "target", "replaced")
    expect(res.ok).toBe(true)
    if (res.ok) {
      const chunk = res.chunks[0]
      expect(chunk.oldLines.join("\n")).toContain("target")
      expect(chunk.newLines.join("\n")).toContain("replaced")
    }
  })

  it("handles multiline oldString", () => {
    const src = "a\nb\nc\nd"
    const res = planSubstringEdit(src, "b\nc", "x\ny")
    expect(res.ok).toBe(true)
  })

  it("handles replaceAll false as single", () => {
    const src = "foo bar foo bar"
    const res = planSubstringEdit(src, "foo", "baz", false)
    expect(res.ok).toBe(false) // multiple without replaceAll should fail
  })
})
