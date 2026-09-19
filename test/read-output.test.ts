import { describe, expect, it } from "bun:test"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { extractHistory } from "../src/language-model.js"
import { mutationArgsWithoutContent, partialReadMutationRefusal } from "../src/protocol/partial-read-guard.js"
import { normalizeOpenCodeReadOutput } from "../src/protocol/read-output.js"

describe("normalizeOpenCodeReadOutput", () => {
  it("unwraps complete OpenCode 1.x file output", () => {
    const output = [
      "<path>/tmp/a.ts</path>",
      "<type>file</type>",
      "<content>",
      "1: const answer = 42",
      "2: ",
      "3: export { answer }",
      "",
      "(End of file - total 3 lines)",
      "</content>",
    ].join("\n")
    expect(normalizeOpenCodeReadOutput(output)).toBe("const answer = 42\n\nexport { answer }")
    expect(normalizeOpenCodeReadOutput("<path>/tmp/empty</path><type>file</type><content>\n</content>")).toBe("")
  })

  it("replaces an OpenCode 1.x cap footer with a mutation-safe notice", () => {
    const output = [
      "<path>/tmp/a.ts</path>",
      "<type>file</type>",
      "<content>",
      "1: first",
      "2: second",
      "",
      "(Output capped at 50 KB. Showing lines 1-2 of 10. Use offset=3 to continue.)",
      "</content>",
    ].join("\n")
    const normalized = normalizeOpenCodeReadOutput(output)
    expect(normalized).toStartWith("first\nsecond\n\n[Partial read:")
    expect(normalized).toContain("lines 1-2 of 10")
    expect(normalized).toContain("Continue with offset=3")
    expect(normalized).toContain("It is NOT the complete file.")
    expect(normalized).not.toContain("<content>")
  })

  it("unwraps complete OpenCode 2.0 output with exact line-number validation", () => {
    const output = "\uFEFFRead file /tmp/a,b.ts, lines 7-9\r\n7: first\r\n8: \r\n9: 42: retained"
    expect(normalizeOpenCodeReadOutput(output)).toBe("first\n\n42: retained")
    expect(normalizeOpenCodeReadOutput("Read file /tmp/empty, 0 lines\n")).toBe("")
  })

  it("preserves OpenCode 2.0 pagination meaning for an unbounded read", () => {
    const output = [
      "Read file /tmp/a.ts, lines 1-2",
      "1: first",
      "2: second",
      "[Output truncated. Continue reading with offset: 3]",
    ].join("\n")
    const normalized = normalizeOpenCodeReadOutput(output)
    expect(normalized).toStartWith("first\nsecond\n\n[Partial read:")
    expect(normalized).toContain("Continue with offset=3")
  })

  it("does not warn for a deliberately bounded page", () => {
    const output = [
      "Read file /tmp/a.ts, lines 5-6",
      "5: first",
      "6: second",
      "[Output truncated. Continue reading with offset: 7]",
    ].join("\n")
    expect(normalizeOpenCodeReadOutput(output, { offset: 5, limit: 2 })).toBe("first\nsecond")
  })

  it("still warns when a bounded OpenCode 2.0 read hits the byte cap", () => {
    const lines = Array.from({ length: 100 }, (_, index) => `${index + 1}: ${"x".repeat(500)}`)
    const output = [
      "Read file /tmp/large.ts, lines 1-100",
      ...lines,
      "[Output truncated. Continue reading with offset: 101]",
    ].join("\n")
    const normalized = normalizeOpenCodeReadOutput(output, { limit: 2_000 })
    expect(normalized).toContain("capped at the host's 50 KB output limit")
    expect(normalized).toContain("Continue with offset=101")
  })

  it("warns about OpenCode 2.0 per-line shortening even at EOF", () => {
    const shortened = `${"x".repeat(2_000)}... (line truncated to 2000 chars)`
    const output = `Read file /tmp/long.txt, lines 1-1\n1: ${shortened}`
    const normalized = normalizeOpenCodeReadOutput(output)
    expect(normalized).toContain("OpenCode shortened line 1 to 2000 characters")
    expect(normalized).toContain("Use a byte-preserving read method")
  })

  it("fails safe when an OpenCode 2.0-looking payload is structurally invalid", () => {
    const output = "Read file /tmp/a.ts, lines 1-2\n1: first\n3: wrong"
    expect(normalizeOpenCodeReadOutput(output)).toBe(output)
  })

  it("does not unwrap a raw file that merely quotes OpenCode 1.x tags", () => {
    const output = "documentation before\n<path>/tmp/a</path><type>file</type><content>\n1: example\n</content>"
    expect(normalizeOpenCodeReadOutput(output)).toBe(output)
  })

  it("correlates the original read range through extractHistory", () => {
    const prompt: LanguageModelV3CallOptions["prompt"] = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "read_1", toolName: "read", input: { path: "/tmp/a", offset: 5, limit: 2 } }] },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "read_1",
          toolName: "read",
          output: { type: "text", value: "Read file /tmp/a, lines 5-6\n5: first\n6: second\n[Output truncated. Continue reading with offset: 7]" },
        }],
      },
    ]
    expect(extractHistory(prompt).find(item => item.role === "tool")?.content).toBe("first\nsecond")
  })
})

describe("partial-read mutation guard", () => {
  const notice = "[Partial read: lines 1-2. It is NOT the complete file. Continue with offset=3 before acting on the whole file.]"

  it("refuses a whole-file write that echoes the provider notice", () => {
    const refusal = partialReadMutationRefusal("write", { path: "/tmp/a", content: `first\n${notice}` })
    expect(refusal?.filePath).toBe("/tmp/a")
    expect(refusal?.reason).toContain("offset=3")
  })

  it("refuses an Add File patch but permits targeted edits and Update File patches", () => {
    expect(partialReadMutationRefusal("apply_patch", {
      patchText: `*** Begin Patch\n*** Add File: a.txt\n+${notice}\n*** End Patch`,
    })).toBeDefined()
    expect(partialReadMutationRefusal("edit", { oldString: "x", newString: notice })).toBeUndefined()
    expect(partialReadMutationRefusal("apply_patch", {
      patchText: `*** Begin Patch\n*** Update File: a.txt\n@@\n-x\n+${notice}\n*** End Patch`,
    })).toBeUndefined()
  })

  it("removes all recognized write-content aliases from a refused call", () => {
    expect(mutationArgsWithoutContent({ filePath: "/tmp/a", file_text: "bad", data: "bad" })).toEqual({ filePath: "/tmp/a" })
    expect(mutationArgsWithoutContent({ patchText: "bad", patch: "bad", note: "kept" })).toEqual({ note: "kept" })
  })
})
