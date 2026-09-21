import { beforeEach, describe, expect, it } from "bun:test"
import {
  clearTurnStateForSession,
  MAX_TURN_STATE_SESSIONS,
  resolveTurnToolState,
  resetTurnToolCatalogForTests,
} from "../src/language-model.js"
import { canonicalizeToolDefs, toolsInFixedOrder } from "../src/protocol/chat.js"

describe("toolsInFixedOrder / canonicalizeToolDefs", () => {
  it("UTF-16-sorts by name only", () => {
    expect(toolsInFixedOrder([
      { name: "write" },
      { name: "bash" },
      { name: "read" },
    ]).map((tool) => tool.name)).toEqual(["bash", "read", "write"])
  })

  it("canonicalizes schema keys without re-sorting the list", () => {
    const tools = canonicalizeToolDefs([
      {
        name: "zeta",
        description: "Z",
        parameters: { properties: { b: { type: "string" }, a: { type: "number" } }, type: "object" },
      },
      {
        name: "alpha",
        description: "A",
        parameters: { required: ["v"], type: "object", properties: { v: { type: "string" } } },
      },
    ])
    expect(tools.map((tool) => tool.name)).toEqual(["zeta", "alpha"])
    expect(Object.keys((tools[0]!.parameters as { properties: object }).properties)).toEqual(["a", "b"])
  })
})

describe("resolveTurnToolState", () => {
  beforeEach(() => {
    resetTurnToolCatalogForTests()
  })

  it("UTF-16-sorts the first nonempty freeze", () => {
    expect(resolveTurnToolState({
      sessionKey: "ses_order",
      incomingTools: [
        { name: "write", description: "w", parameters: {} },
        { name: "bash", description: "b", parameters: {} },
        { name: "read", description: "r", parameters: {} },
      ],
      isCompaction: false,
    }).advertisedTools.map((tool) => tool.name)).toEqual(["bash", "read", "write"])
  })

  it("holds first-catalog order when the host reshuffles the same names", () => {
    const first = resolveTurnToolState({
      sessionKey: "ses_reshuffle",
      incomingTools: [
        { name: "write", description: "w", parameters: {} },
        { name: "bash", description: "b", parameters: {} },
        { name: "read", description: "r", parameters: {} },
      ],
      isCompaction: false,
    })
    expect(resolveTurnToolState({
      sessionKey: "ses_reshuffle",
      incomingTools: [
        { name: "read", description: "r2", parameters: { extra: true } },
        { name: "write", description: "w2", parameters: {} },
        { name: "bash", description: "b2", parameters: {} },
      ],
      isCompaction: false,
    })).toEqual(first)
  })

  it("keeps frozen descriptors when the name set is unchanged", () => {
    const original = [{ name: "read", description: "v1", parameters: { type: "object" } }]
    resolveTurnToolState({
      sessionKey: "ses_same_names",
      incomingTools: original,
      isCompaction: false,
    })
    expect(resolveTurnToolState({
      sessionKey: "ses_same_names",
      incomingTools: [{ name: "read", description: "v2", parameters: { type: "string" } }],
      isCompaction: false,
    }).advertisedTools).toEqual(original)
  })

  it("appends new names in UTF-16 order at the tail", () => {
    resolveTurnToolState({
      sessionKey: "ses_grow",
      incomingTools: [{ name: "z", description: "z", parameters: {} }],
      isCompaction: false,
    })
    expect(resolveTurnToolState({
      sessionKey: "ses_grow",
      incomingTools: [
        { name: "z", description: "z2", parameters: {} },
        { name: "c", description: "c", parameters: {} },
        { name: "a", description: "a", parameters: {} },
      ],
      isCompaction: false,
    }).advertisedTools.map((tool) => tool.name)).toEqual(["z", "a", "c"])
  })

  it("merges new names without rewriting existing descriptors", () => {
    const original = [{ name: "read", description: "v1", parameters: {} }]
    resolveTurnToolState({
      sessionKey: "ses_grow_hold",
      incomingTools: original,
      isCompaction: false,
    })
    expect(resolveTurnToolState({
      sessionKey: "ses_grow_hold",
      incomingTools: [
        { name: "bash", description: "shell", parameters: {} },
        { name: "read", description: "v2", parameters: {} },
      ],
      isCompaction: false,
    }).advertisedTools).toEqual([
      { name: "read", description: "v1", parameters: {} },
      { name: "bash", description: "shell", parameters: {} },
    ])
  })

  it("drops omitted names but keeps frozen order of survivors", () => {
    resolveTurnToolState({
      sessionKey: "ses_shrink",
      incomingTools: [
        { name: "bash", description: "b", parameters: {} },
        { name: "read", description: "r", parameters: {} },
        { name: "write", description: "w", parameters: {} },
      ],
      isCompaction: false,
    })
    expect(resolveTurnToolState({
      sessionKey: "ses_shrink",
      incomingTools: [{ name: "write", description: "w2", parameters: {} }, { name: "bash", description: "b2", parameters: {} }],
      isCompaction: false,
    }).advertisedTools.map((tool) => tool.name)).toEqual(["bash", "write"])
  })

  it("restores temporarily omitted names at their original epoch positions", () => {
    const original = [
      { name: "bash", description: "b1", parameters: {} },
      { name: "read", description: "r1", parameters: {} },
      { name: "write", description: "w1", parameters: {} },
    ]
    resolveTurnToolState({
      sessionKey: "ses_restore",
      incomingTools: original,
      isCompaction: false,
    })
    resolveTurnToolState({
      sessionKey: "ses_restore",
      incomingTools: [original[0]!, original[2]!],
      isCompaction: false,
    })
    expect(resolveTurnToolState({
      sessionKey: "ses_restore",
      incomingTools: [
        { name: "write", description: "w2", parameters: { changed: true } },
        { name: "read", description: "r2", parameters: { changed: true } },
        { name: "bash", description: "b2", parameters: { changed: true } },
      ],
      isCompaction: false,
    }).advertisedTools).toEqual(original)
  })

  it("does not forget omitted epoch tools when a newcomer arrives", () => {
    const original = [
      { name: "bash", description: "b", parameters: {} },
      { name: "read", description: "r", parameters: {} },
    ]
    resolveTurnToolState({
      sessionKey: "ses_shrink_grow",
      incomingTools: original,
      isCompaction: false,
    })
    expect(resolveTurnToolState({
      sessionKey: "ses_shrink_grow",
      incomingTools: [
        { name: "write", description: "w", parameters: {} },
        original[0]!,
      ],
      isCompaction: false,
    }).advertisedTools.map((tool) => tool.name)).toEqual(["bash", "write"])
    expect(resolveTurnToolState({
      sessionKey: "ses_shrink_grow",
      incomingTools: [original[1]!, original[0]!, { name: "write", description: "w2", parameters: {} }],
      isCompaction: false,
    }).advertisedTools.map((tool) => tool.name)).toEqual(["bash", "read", "write"])
  })

  it("advertises no tools on compaction and restores the catalog afterward", () => {
    const tools = [
      { name: "bash", description: "b", parameters: {} },
      { name: "read", description: "r", parameters: {} },
    ]
    resolveTurnToolState({ sessionKey: "ses_comp", incomingTools: tools, isCompaction: false })
    expect(resolveTurnToolState({
      sessionKey: "ses_comp",
      incomingTools: [],
      isCompaction: true,
    }).advertisedTools).toEqual([])
    expect(resolveTurnToolState({
      sessionKey: "ses_comp",
      incomingTools: tools,
      isCompaction: false,
    }).advertisedTools).toEqual(tools)
  })

  it("counts compaction as LRU activity without advertising tools", () => {
    const original = [{ name: "read", description: "original", parameters: {} }]
    resolveTurnToolState({
      sessionKey: "ses_active_compaction",
      incomingTools: original,
      isCompaction: false,
    })
    for (let i = 0; i < MAX_TURN_STATE_SESSIONS - 1; i++) {
      resolveTurnToolState({
        sessionKey: `ses_pressure_${i}`,
        incomingTools: [{ name: "read", description: String(i), parameters: {} }],
        isCompaction: false,
      })
    }
    expect(resolveTurnToolState({
      sessionKey: "ses_active_compaction",
      incomingTools: [],
      isCompaction: true,
    }).advertisedTools).toEqual([])
    resolveTurnToolState({
      sessionKey: "ses_pressure_last",
      incomingTools: [{ name: "read", description: "last", parameters: {} }],
      isCompaction: false,
    })
    expect(resolveTurnToolState({
      sessionKey: "ses_active_compaction",
      incomingTools: [{ name: "read", description: "replacement", parameters: {} }],
      isCompaction: false,
    }).advertisedTools).toEqual(original)
  })

  it("drops a deleted session epoch instead of reusing stale descriptors", () => {
    resolveTurnToolState({
      sessionKey: "ses_deleted",
      incomingTools: [{ name: "read", description: "old", parameters: {} }],
      isCompaction: false,
    })
    clearTurnStateForSession("ses_deleted")
    expect(resolveTurnToolState({
      sessionKey: "ses_deleted",
      incomingTools: [{ name: "read", description: "new", parameters: { type: "object" } }],
      isCompaction: false,
    }).advertisedTools).toEqual([
      { name: "read", description: "new", parameters: { type: "object" } },
    ])
  })
})
