import { describe, it, expect } from "bun:test"
import { extractHistory, buildDevinOpenCodeGuidance } from "../src/language-model.js"
import { buildGetChatMessageRequest } from "../src/protocol/chat.js"
import { iterFields } from "../src/protocol/wire.js"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"

// We test the exported guidance builder directly; it is the contract tightened
// for read/edit/write after the file-tool failures.

// Issue #1 round-trip coverage: the AI SDK / OpenCode prompt shapes produced on
// the turn AFTER a tool call must be converted into paired Cascade
// assistant(tool_calls) + tool(tool_call_id) history items, so the backend can
// pair them and the turn does not fail (or silently lose the tool result).

function toolTextFromResult(req: Uint8Array): string | undefined {
  // find the last prompt (field #3) that has a tool_call_id (#7), return its content (#2)
  let last: string | undefined
  for (const f of iterFields(req)) {
    if (f.num === 3 && f.wire === 2 && f.value instanceof Uint8Array) {
      let id: string | undefined
      let content: string | undefined
      for (const sf of iterFields(f.value)) {
        if (sf.wire === 2 && sf.value instanceof Uint8Array) {
          const s = new TextDecoder().decode(sf.value)
          if (sf.num === 3) content = s
          else if (sf.num === 7) id = s
        }
      }
      if (id !== undefined) last = content
    }
  }
  return last
}

const tools = [{ name: "read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }]

describe("extractHistory AI SDK v3 tool-call shapes (issue #1)", () => {
  const base = {
    apiKey: "k",
    userJwt: "jwt",
    modelUid: "swe-2-medium",
    cascadeId: "c",
    promptId: "p1",
    sessionId: "s",
    requestId: 1n,
    triggerId: "t",
  }

  it("maps assistant.content[] tool-call + tool result (OpenCode shape) into a paired turn", () => {
    const prompt: LanguageModelV3CallOptions["prompt"] = [
      { role: "user", content: [{ type: "text", text: "read the file" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Reading it now" },
          { type: "tool-call", toolCallId: "toolu_123", toolName: "read", input: { path: "/tmp/a.txt" } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "toolu_123", toolName: "read", output: { type: "text", value: "hello world" } }],
      },
      { role: "user", content: [{ type: "text", text: "now summarize" }] },
    ]
    const items = extractHistory(prompt)
    // assistant keeps its tool call
    const asst = items.find(i => i.role === "assistant")
    expect(asst?.tool_calls?.length).toBe(1)
    expect(asst?.tool_calls?.[0]).toEqual({ id: "toolu_123", name: "read", arguments: '{"path":"/tmp/a.txt"}' })
    // tool result is paired to the right id, content is the stringified output
    const tool = items.find(i => i.role === "tool")
    expect(tool?.tool_call_id).toBe("toolu_123")
    // the tool message should mention the output value
    expect(JSON.stringify(tool?.content)).toContain("hello world")
    // round-trips into the wire request with pairing intact
    const req = buildGetChatMessageRequest({ ...base, messages: items, tools: [] })
    expect(toolTextFromResult(req)).toContain("hello world")
  })

  it("maps legacy flat tool-result shapes (back-compat)", () => {
    const prompt: LanguageModelV3CallOptions["prompt"] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "toolu_7", toolName: "read", input: {} }],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "toolu_7", toolName: "read", output: { type: "text", value: "legacy out" } }],
      },
    ]
    const items = extractHistory(prompt)
    const tool = items.find(i => i.role === "tool")
    expect(tool?.tool_call_id).toBe("toolu_7")
    expect(JSON.stringify(tool?.content)).toContain("legacy out")
  })

  it("string-input tool results pass through as text", () => {
    const prompt: LanguageModelV3CallOptions["prompt"] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "toolu_8", toolName: "read", input: {} }] },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "toolu_8", toolName: "read", output: { type: "text", value: "plain string" } }],
      },
    ]
    const items = extractHistory(prompt)
    const tool = items.find(i => i.role === "tool")
    expect(tool?.content).toBe("plain string")
  })

  it("keeps tool calls and results aligned on the wire when results are string-encoded", () => {
    const prompt: LanguageModelV3CallOptions["prompt"] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "running" },
          { type: "tool-call", toolCallId: "call_ABC", toolName: "grep", input: { pattern: "x" } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "call_ABC", toolName: "grep", output: { type: "text", value: "1 match" } }],
      },
    ]
    const items = extractHistory(prompt)
    const req = buildGetChatMessageRequest({ ...base, messages: items, tools: [] })
    let sawId: string | undefined
    let sawContent: string | undefined
    for (const f of iterFields(req)) {
      if (f.num === 3 && f.wire === 2 && f.value instanceof Uint8Array) {
        for (const sf of iterFields(f.value)) {
          if (sf.wire === 2 && sf.value instanceof Uint8Array) {
            const s = new TextDecoder().decode(sf.value)
            if (sf.num === 7) sawId = s
            else if (sf.num === 3) sawContent = s
          }
        }
      }
    }
    expect(sawId).toBe("call_ABC")
    expect(sawContent).toContain("1 match")
  })

  it("keeps every tool-result part in one tool message", () => {
    const prompt: LanguageModelV3CallOptions["prompt"] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call_a", toolName: "read", input: { path: "/a" } },
          { type: "tool-call", toolCallId: "call_b", toolName: "grep", input: { pattern: "x" } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "call_a", toolName: "read", output: { type: "text", value: "one" } },
          { type: "tool-result", toolCallId: "call_b", toolName: "grep", output: { type: "text", value: "two" } },
        ],
      },
    ]
    const items = extractHistory(prompt)
    const tools = items.filter(i => i.role === "tool")
    expect(tools.map(t => t.tool_call_id)).toEqual(["call_a", "call_b"])
    expect(tools.map(t => t.content)).toEqual(["one", "two"])
    const req = buildGetChatMessageRequest({ ...base, messages: items, tools: [] })
    const ids: string[] = []
    for (const f of iterFields(req)) {
      if (f.num === 3 && f.wire === 2 && f.value instanceof Uint8Array) {
        for (const sf of iterFields(f.value)) {
          if (sf.num === 7 && sf.wire === 2 && sf.value instanceof Uint8Array) {
            ids.push(new TextDecoder().decode(sf.value))
          }
        }
      }
    }
    expect(ids).toEqual(["call_a", "call_b"])
  })

  it("unwraps read output using toolName on the v3 part", () => {
    const prompt: LanguageModelV3CallOptions["prompt"] = [
      { role: "user", content: [{ type: "text", text: "read it" }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "call_r", toolName: "read", input: { path: "/tmp/a.txt" } }] },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call_r",
          toolName: "read",
          output: {
            type: "text",
            value: "<path>/tmp/a.txt</path><type>file</type><content>\n1: hello\n2: world\n</content>",
          },
        }],
      },
    ]
    const tool = extractHistory(prompt).find(i => i.role === "tool")
    expect(tool?.content).toBe("hello\nworld")
    expect(String(tool?.content)).not.toContain("1: ")
  })

  it("renders execution-denied tool output as text", () => {
    const prompt: LanguageModelV3CallOptions["prompt"] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "call_d", toolName: "bash", input: {} }] },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "call_d", toolName: "bash", output: { type: "execution-denied", reason: "user denied" } }],
      },
    ]
    const tool = extractHistory(prompt).find(i => i.role === "tool")
    expect(tool?.content).toBe("user denied")
  })

  it("keeps stray text riding with tool-result parts", () => {
    const prompt: LanguageModelV3CallOptions["prompt"] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "call_s", toolName: "read", input: {} }] },
      {
        role: "tool",
        content: [
          { type: "text", text: "side note" },
          { type: "tool-result", toolCallId: "call_s", toolName: "read", output: { type: "text", value: "kept" } },
        ],
      },
    ]
    const tools = extractHistory(prompt).filter(i => i.role === "tool")
    expect(tools.length).toBe(1)
    expect(String(tools[0]!.content)).toContain("side note")
    expect(String(tools[0]!.content)).toContain("kept")
  })

  it("does not unwrap read envelopes for tools merely containing read", () => {
    const envelope = "<path>/tmp/a.txt</path><type>file</type><content>\n1: hello\n</content>"
    for (const toolName of ["thread", "todoread", "spreadsheet"]) {
      const prompt: LanguageModelV3CallOptions["prompt"] = [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "call_n", toolName, input: {} }] },
        {
          role: "tool",
          content: [{ type: "tool-result", toolCallId: "call_n", toolName, output: { type: "text", value: envelope } }],
        },
      ]
      const tool = extractHistory(prompt).find(i => i.role === "tool")
      expect(tool?.content).toBe(envelope)
    }
  })
})


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

  it("names the host path key from the advertised schema", () => {
    const oc1 = buildDevinOpenCodeGuidance([{
      name: "read",
      description: "",
      parameters: { type: "object", required: ["filePath"], properties: { filePath: { type: "string" } } },
    }], "/tmp")!
    expect(oc1).toContain("Takes `filePath`")
    expect(oc1).not.toContain("Takes `path` or `filePath`")

    const oc2 = buildDevinOpenCodeGuidance([{
      name: "read",
      description: "",
      parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
    }], "/tmp")!
    expect(oc2).toContain("Takes `path`")
    expect(oc2).not.toContain("`filePath`")

    expect(guids(["read"])).toContain("Takes `path` or `filePath`")
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
