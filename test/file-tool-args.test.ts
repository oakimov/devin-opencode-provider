import { describe, it, expect } from "bun:test"
import { fileArgPhrase, hostFilePathKey, normalizeFileToolArgs } from "../src/protocol/file-tool-args.js"

const oc1 = {
  type: "object",
  required: ["filePath"],
  properties: { filePath: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } },
}

const oc2 = {
  type: "object",
  required: ["path"],
  properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } },
}

describe("hostFilePathKey", () => {
  it("detects OpenCode 1.x filePath schema", () => {
    expect(hostFilePathKey(oc1)).toBe("filePath")
    expect(fileArgPhrase(oc1)).toBe("`filePath`")
  })

  it("detects OpenCode 2.0 path schema", () => {
    expect(hostFilePathKey(oc2)).toBe("path")
    expect(fileArgPhrase(oc2)).toBe("`path`")
  })

  it("unwraps jsonSchema wrappers", () => {
    expect(hostFilePathKey({ jsonSchema: oc1 })).toBe("filePath")
  })

  it("keeps both when schema is unknown", () => {
    expect(hostFilePathKey(undefined)).toBe("both")
    expect(hostFilePathKey({})).toBe("both")
    expect(fileArgPhrase({})).toBe("`path` or `filePath`")
  })
})

describe("normalizeFileToolArgs", () => {
  it("does not strip filePath for OpenCode 1.x (the SchemaError bug)", () => {
    const out = normalizeFileToolArgs("read", { filePath: "/tmp/package.json" }, oc1)
    expect(out).toEqual({ filePath: "/tmp/package.json" })
  })

  it("maps path -> filePath for OpenCode 1.x", () => {
    expect(normalizeFileToolArgs("read", { path: "/tmp/a.ts" }, oc1)).toEqual({ filePath: "/tmp/a.ts" })
  })

  it("maps filePath -> path for OpenCode 2.0", () => {
    expect(normalizeFileToolArgs("read", { filePath: "/tmp/a.ts" }, oc2)).toEqual({ path: "/tmp/a.ts" })
  })

  it("keeps both keys when the host schema is unknown", () => {
    expect(normalizeFileToolArgs("read", { filePath: "/tmp/a.ts" })).toEqual({
      path: "/tmp/a.ts",
      filePath: "/tmp/a.ts",
    })
  })

  it("promotes file_path / filename / target_file aliases", () => {
    expect(normalizeFileToolArgs("read", { file_path: "/tmp/a.ts" }, oc1)).toEqual({ filePath: "/tmp/a.ts" })
    expect(normalizeFileToolArgs("read", { filename: "/tmp/a.ts" }, oc1)).toEqual({ filePath: "/tmp/a.ts" })
    expect(normalizeFileToolArgs("write", { target_file: "/tmp/a.ts", content: "x" }, oc1)).toEqual({
      filePath: "/tmp/a.ts",
      content: "x",
    })
  })

  it("coerces offset/limit numeric strings", () => {
    expect(normalizeFileToolArgs("read", { filePath: "/tmp/a.ts", offset: "10", limit: "5" }, oc1)).toEqual({
      filePath: "/tmp/a.ts",
      offset: 10,
      limit: 5,
    })
  })

  it("maps edit aliases including empty oldString", () => {
    expect(normalizeFileToolArgs("edit", { filePath: "a.ts", old_string: "", new_string: "y", replace_all: true }, oc1)).toEqual({
      filePath: "a.ts",
      oldString: "",
      newString: "y",
      replaceAll: true,
    })
  })

  it("maps write content aliases", () => {
    expect(normalizeFileToolArgs("write", { path: "a.ts", file_text: "hello" }, oc2)).toEqual({
      path: "a.ts",
      content: "hello",
    })
  })

  it("leaves glob/bash args untouched (including identity)", () => {
    const glob = { pattern: ".github/**/*.yml" }
    expect(normalizeFileToolArgs("glob", glob)).toBe(glob)
    const bash = { command: "ls" }
    expect(normalizeFileToolArgs("bash", bash)).toBe(bash)
  })
})
