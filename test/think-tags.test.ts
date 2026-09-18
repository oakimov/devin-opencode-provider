import { describe, it, expect } from "bun:test"
import {
  feedThinkTags,
  flushThinkTags,
  newThinkTagState,
  splitThinkDocument,
  thinkTagHoldLen,
} from "../src/think-tags.js"

function collect(chunks: string[]): { kind: string; text: string }[] {
  const state = newThinkTagState()
  const out: { kind: string; text: string }[] = []
  for (const c of chunks) out.push(...feedThinkTags(c, state))
  out.push(...flushThinkTags(state))
  return out
}

describe("thinkTagHoldLen", () => {
  it("holds a proper prefix of the close tag", () => {
    expect(thinkTagHoldLen("</th", "</think>")).toBe(4)
    expect(thinkTagHoldLen("hello", "</think>")).toBe(0)
    expect(thinkTagHoldLen("</think>", "</think>")).toBe(0)
  })
})

describe("feedThinkTags", () => {
  it("routes paired tags to reasoning and the rest to text", () => {
    expect(splitThinkDocument("pre<think>secret</think>post")).toEqual({
      thinking: "secret",
      text: "prepost",
    })
  })

  it("drops a stray close tag and does not emit it as text", () => {
    expect(splitThinkDocument("</think>\nHello")).toEqual({
      thinking: "",
      text: "\nHello",
    })
  })

  it("treats prefix before a stray close as reasoning until visible text", () => {
    expect(splitThinkDocument("secret</think>Hello")).toEqual({
      thinking: "secret",
      text: "Hello",
    })
  })

  it("splits a close tag across chunks", () => {
    const events = collect(["</th", "ink>\nHi"])
    expect(events.some((e) => e.text.includes("</think>"))).toBe(false)
    expect(events.filter((e) => e.kind === "text").map((e) => e.text).join("")).toBe("\nHi")
  })

  it("splits an open tag across chunks", () => {
    const events = collect(["<thi", "nk>abc</think>done"])
    expect(events).toEqual([
      { kind: "reasoning", text: "abc" },
      { kind: "text", text: "done" },
    ])
  })

  it("does not flush a partial tag at end of stream as visible text", () => {
    const state = newThinkTagState()
    expect(feedThinkTags("ok</thin", state)).toEqual([{ kind: "text", text: "ok" }])
    expect(flushThinkTags(state)).toEqual([])
  })
})
