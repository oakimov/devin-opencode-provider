import { describe, expect, it } from "bun:test"
import path from "node:path"
import { extractHistory } from "../src/language-model.js"
import { groundToolResultText } from "../src/protocol/tool-paths.js"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"

const root = "/workspace/project"

describe("groundToolResultText", () => {
  it("keeps grep line previews and absolutizes only the file header", () => {
    const output = [
      "Found 1 matches",
      "src/a.ts:",
      "  Line 12: const answer = 42",
      "",
      "(Results are truncated. Consider using a more specific path or pattern.)",
    ].join("\n")
    expect(groundToolResultText("grep", output, root)).toBe(
      [
        "Found 1 matches",
        `${root}/src/a.ts:`,
        "  Line 12: const answer = 42",
        "",
        "(Results are truncated. Consider using a more specific path or pattern.)",
      ].join("\n"),
    )
  })

  it("does not rewrite an already-absolute grep page or a non-search tool", () => {
    const output = ["Found 1 matches", "/abs/a.ts:", "  Line 2: see src/b.ts"].join("\n")
    expect(groundToolResultText("grep", output, root)).toBe(output)
    expect(groundToolResultText("question", output, root)).toBe(output)
    expect(groundToolResultText("grep", output, undefined)).toBe(output)
  })

  it("absolutizes glob rows and leaves home paths and footers", () => {
    const output = [
      "src/a.ts",
      "~/keep.ts",
      "(Results are truncated: showing first 1 results. Consider using a more specific path or pattern.)",
    ].join("\n")
    expect(groundToolResultText("glob", output, root)).toBe(
      [
        `${root}/src/a.ts`,
        "~/keep.ts",
        "(Results are truncated: showing first 1 results. Consider using a more specific path or pattern.)",
      ].join("\n"),
    )
  })

  it("joins OpenCode 2 directory names onto the directory, including Windows and UNC", () => {
    expect(groundToolResultText("read", ["Read directory src, entries 1-4", "./a.ts", "../b.ts", "nested/", "~/keep.ts"].join("\n"), root)).toBe(
      [
        `Read directory ${root}/src, entries 1-4`,
        `${root}/src/a.ts`,
        `${root}/b.ts`,
        `${root}/src/nested${path.sep}`,
        "~/keep.ts",
      ].join("\n"),
    )
    expect(groundToolResultText("read", "Read directory src, 0 entries", root)).toBe(`Read directory ${root}/src, 0 entries`)
    expect(groundToolResultText("read", "Read directory src, entries 1-2\na.ts\n\nb.ts", root)).toBe(
      "Read directory src, entries 1-2\na.ts\n\nb.ts",
    )

    expect(groundToolResultText("read", ["Read directory C:/proj, entries 1-3", "a.ts", "nested/", "../b.ts"].join("\n"), root)).toBe(
      ["Read directory C:/proj, entries 1-3", "C:/proj/a.ts", "C:/proj/nested/", "C:/b.ts"].join("\n"),
    )
    expect(groundToolResultText("read", ["Read directory C:\\proj, entries 1-1", "a.ts"].join("\n"), root)).toBe(
      ["Read directory C:\\proj, entries 1-1", "C:\\proj\\a.ts"].join("\n"),
    )
    expect(groundToolResultText("read", ["Read directory \\\\server\\share, entries 1-1", "a.ts"].join("\n"), root)).toBe(
      ["Read directory \\\\server\\share, entries 1-1", "\\\\server\\share\\a.ts"].join("\n"),
    )
  })

  it("joins OpenCode 1 directory entry names onto the path tag", () => {
    const output = [
      "<path>/tmp/proj</path>",
      "<type>directory</type>",
      "<entries>",
      "a.ts",
      "src/",
      "",
      "(2 entries)",
      "</entries>",
    ].join("\n")
    expect(groundToolResultText("read", output, root)).toBe(
      [
        "<path>/tmp/proj</path>",
        "<type>directory</type>",
        "<entries>",
        "/tmp/proj/a.ts",
        `/tmp/proj/src${path.sep}`,
        "",
        "(2 entries)",
        "</entries>",
      ].join("\n"),
    )
  })

  it("rewrites shell path tokens against workdir and leaves prose and bare names", () => {
    const stdout = [
      "src/a.ts",
      "built src/a.ts ok",
      "https://example.com/a",
      "/abs/b.ts",
      "src/c.ts:12:3",
      "~/secret",
      "README.md",
      "C:/src/a.ts",
    ].join("\n")
    expect(groundToolResultText("bash", stdout, root, { workdir: "pkg" })).toBe(
      [
        `${root}/pkg/src/a.ts`,
        "built src/a.ts ok",
        "https://example.com/a",
        "/abs/b.ts",
        `${root}/pkg/src/c.ts:12:3`,
        "~/secret",
        "README.md",
        "C:/src/a.ts",
      ].join("\n"),
    )
    expect(groundToolResultText("shell", "./src/b.ts", root, { working_directory: "/tmp/work" })).toBe("/tmp/work/src/b.ts")
    expect(groundToolResultText("bash", "src/a.ts", undefined)).toBe("src/a.ts")
    expect(groundToolResultText("edit", "src/a.ts", root)).toBe("src/a.ts")
  })
})

describe("extractHistory path grounding", () => {
  it("keeps grep match lines when the next turn is built", () => {
    const prompt: LanguageModelV3CallOptions["prompt"] = [
      { role: "user", content: [{ type: "text", text: "find it" }] },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call_g", toolName: "grep", input: { pattern: "answer" } }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call_g",
          toolName: "grep",
          output: {
            type: "text",
            value: ["Found 1 matches", "src/a.ts:", "  Line 12: const answer = 42"].join("\n"),
          },
        }],
      },
    ]
    const tool = extractHistory(prompt, root).find((item) => item.role === "tool")
    expect(tool?.content).toBe(
      ["Found 1 matches", `${root}/src/a.ts:`, "  Line 12: const answer = 42"].join("\n"),
    )
  })
})
