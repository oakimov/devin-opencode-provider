import { describe, expect, test } from "bun:test"
import {
  executeOpenCodeWebSearch,
  fetchOpenCodeWebSearchText,
  normalizeOpenCodeWebSearchArgs,
  normalizeWebSearchUrl,
  parseExaWebSearchResults,
} from "../src/web-tools.js"

describe("web search validation", () => {
  test("requires a non-empty query and rejects bad tuning fields", () => {
    expect(normalizeOpenCodeWebSearchArgs({ query: "  rust lifetimes  " })).toEqual({ query: "rust lifetimes" })
    expect(() => normalizeOpenCodeWebSearchArgs({ query: "   " })).toThrow(/required/)
    expect(() => normalizeOpenCodeWebSearchArgs({ query: "ok", numResults: 0 })).toThrow(/numResults/)
    expect(() => normalizeOpenCodeWebSearchArgs({ query: "ok", livecrawl: "always" })).toThrow(/livecrawl/)
    expect(() => normalizeOpenCodeWebSearchArgs({ query: "ok", type: "slow" })).toThrow(/type/)
    expect(() => normalizeOpenCodeWebSearchArgs("nope")).toThrow(/object/)
  })

  test("keeps http(s) result urls and drops the rest", () => {
    expect(normalizeWebSearchUrl("https://example.com/a")).toBe("https://example.com/a")
    expect(normalizeWebSearchUrl("javascript:alert(1)")).toBeUndefined()
    expect(normalizeWebSearchUrl("/relative")).toBeUndefined()
    const results = parseExaWebSearchResults(JSON.stringify({
      results: [
        { url: "https://example.com/ok", title: " Ok ", text: "body" },
        { url: "javascript:alert(1)", title: "bad" },
        { href: "not a url", title: "also bad" },
      ],
    }))
    expect(results).toEqual([
      { url: "https://example.com/ok", title: "Ok", content: "body", time: {} },
    ])
    expect(parseExaWebSearchResults(null)).toEqual([])
  })

  test("fetch rejects an empty query before calling the network", async () => {
    let called = false
    await expect(fetchOpenCodeWebSearchText({ query: " " }, undefined, async () => {
      called = true
      return new Response("")
    })).rejects.toThrow(/required/)
    expect(called).toBe(false)
  })

  test("execute asks permission with the normalized query", async () => {
    const asked: string[] = []
    const result = await executeOpenCodeWebSearch(
      { query: "  widgets  ", numResults: 3 },
      {
        ask: async (input) => {
          asked.push(input.patterns[0] ?? "")
        },
      },
      async () => new Response(JSON.stringify({
        result: { content: [{ type: "text", text: "Title: Widgets\nURL: https://example.com/w\n" }] },
      })),
    )
    expect(asked).toEqual(["widgets"])
    expect(result.title).toBe("Exa Web Search: widgets")
    expect(result.output).toContain("https://example.com/w")
  })
})
