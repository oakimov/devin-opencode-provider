import { describe, it, expect, afterEach } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { remapDevinEditForApplyPatchCatalog } from "../src/protocol/apply-patch-bridge.js"

let tmp = ""
afterEach(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  tmp = ""
})

async function mkRoot(files: Record<string, string>) {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "devin-patch-bridge-"))
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.join(tmp, path.dirname(rel)), { recursive: true })
    await fs.writeFile(path.join(tmp, rel), content)
  }
  return tmp
}

describe("remapDevinEditForApplyPatchCatalog", () => {
  it("passes through when edit is advertised", async () => {
    const r = remapDevinEditForApplyPatchCatalog({ toolName: "edit", input: { filePath: "a.txt", oldString: "x", newString: "y" }, advertisedToolNames: new Set(["edit", "write", "apply_patch"]), workspaceRoot: "/tmp" })
    expect(r.type).toBe("passthrough")
  })

  it("passes through non-file tools", async () => {
    const r = remapDevinEditForApplyPatchCatalog({ toolName: "read", input: { filePath: "a.txt" }, advertisedToolNames: new Set(["apply_patch"]), workspaceRoot: "/tmp" })
    expect(r.type).toBe("passthrough")
  })

  it("refuses when no path", async () => {
    const r = remapDevinEditForApplyPatchCatalog({ toolName: "write", input: { content: "hi" }, advertisedToolNames: new Set(["apply_patch"]), workspaceRoot: "/tmp" })
    expect(r.type).toBe("refused")
  })

  it("patches write to add-file", async () => {
    const root = await mkRoot({})
    const r = remapDevinEditForApplyPatchCatalog({ toolName: "write", input: { path: "new.txt", content: "hello" }, advertisedToolNames: new Set(["apply_patch"]), workspaceRoot: root })
    expect(r.type).toBe("patched")
    if (r.type === "patched") expect(r.patchText).toContain("*** Add File: new.txt")
  })

  it("handles filePath alias for write", async () => {
    const root = await mkRoot({})
    const r = remapDevinEditForApplyPatchCatalog({ toolName: "write", input: { filePath: "new2.txt", content: "hi" }, advertisedToolNames: new Set(["apply_patch"]), workspaceRoot: root })
    expect(r.type).toBe("patched")
  })

  it("handles file_path alias and file_text", async () => {
    const root = await mkRoot({})
    const r = remapDevinEditForApplyPatchCatalog({ toolName: "write", input: { file_path: "x.txt", file_text: "hey" } as any, advertisedToolNames: new Set(["apply_patch"]), workspaceRoot: root })
    expect(r.type).toBe("patched")
  })

  it("refuses write with no content", async () => {
    const root = await mkRoot({})
    const r = remapDevinEditForApplyPatchCatalog({ toolName: "write", input: { path: "a.txt" }, advertisedToolNames: new Set(["apply_patch"]), workspaceRoot: root })
    expect(r.type).toBe("refused")
  })

  it("patches edit with existing file", async () => {
    const root = await mkRoot({ "a.txt": "hello world\nsecond line\n" })
    const r = remapDevinEditForApplyPatchCatalog({ toolName: "edit", input: { filePath: "a.txt", oldString: "world", newString: "there" }, advertisedToolNames: new Set(["apply_patch"]), workspaceRoot: root })
    expect(r.type).toBe("patched")
    if (r.type === "patched") expect(r.patchText).toContain("*** Update File: a.txt")
  })

  it("refuses edit when file cannot be read", async () => {
    const root = await mkRoot({})
    const r = remapDevinEditForApplyPatchCatalog({ toolName: "edit", input: { filePath: "missing.txt", oldString: "x", newString: "y" }, advertisedToolNames: new Set(["apply_patch"]), workspaceRoot: root })
    expect(r.type).toBe("refused")
  })

  it("refuses edit missing old/new text", async () => {
    const root = await mkRoot({ "a.txt": "hi" })
    const r = remapDevinEditForApplyPatchCatalog({ toolName: "edit", input: { filePath: "a.txt", oldString: "hi" } as any, advertisedToolNames: new Set(["apply_patch"]), workspaceRoot: root })
    expect(r.type).toBe("refused")
  })

  it("handles old_string / new_string aliases", async () => {
    const root = await mkRoot({ "a.txt": "hello world" })
    const r = remapDevinEditForApplyPatchCatalog({ toolName: "edit", input: { filePath: "a.txt", old_string: "world", new_string: "there" } as any, advertisedToolNames: new Set(["apply_patch"]), workspaceRoot: root })
    expect(r.type).toBe("patched")
  })

  it("refuses edit with multiple matches without replaceAll", async () => {
    const root = await mkRoot({ "a.txt": "a a a" })
    const r = remapDevinEditForApplyPatchCatalog({ toolName: "edit", input: { filePath: "a.txt", oldString: "a", newString: "b" }, advertisedToolNames: new Set(["apply_patch"]), workspaceRoot: root })
    expect(r.type).toBe("refused")
  })

  it("patches with replaceAll on separate lines", async () => {
    const root = await mkRoot({ "a.txt": "foo TARGET bar\nother\nfoo TARGET bar\nother\nfoo TARGET bar" })
    const r = remapDevinEditForApplyPatchCatalog({ toolName: "edit", input: { filePath: "a.txt", oldString: "TARGET", newString: "REPLACED", replaceAll: true }, advertisedToolNames: new Set(["apply_patch"]), workspaceRoot: root })
    expect(r.type).toBe("patched")
  })

  it("is inert when neither edit/write nor apply_patch advertised", async () => {
    const r = remapDevinEditForApplyPatchCatalog({ toolName: "edit", input: { filePath: "a.txt", oldString: "x", newString: "y" }, advertisedToolNames: new Set(["read"]), workspaceRoot: "/tmp" })
    expect(r.type).toBe("passthrough")
  })

  it("accepts array form for advertisedToolNames", async () => {
    const root = await mkRoot({})
    const r = remapDevinEditForApplyPatchCatalog({ toolName: "write", input: { path: "b.txt", content: "hi" }, advertisedToolNames: ["apply_patch"], workspaceRoot: root })
    expect(r.type).toBe("patched")
  })

  it("accepts target_file as a path alias", async () => {
    const root = await mkRoot({})
    const r = remapDevinEditForApplyPatchCatalog({ toolName: "write", input: { target_file: "c.txt", content: "hi" }, advertisedToolNames: new Set(["apply_patch"]), workspaceRoot: root })
    expect(r.type).toBe("patched")
    if (r.type === "patched") expect(r.filePath).toBe("c.txt")
  })
})
