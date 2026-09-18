import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import {
  clearAllSessionTodos,
  getSessionTodos,
  normalizeSessionTodos,
  setSessionTodos,
} from "../src/todo-store.js"
import {
  DEVIN_OPENCODE2_TODOS_ENV,
  hostHasTool,
  isOpenCode2TodosEnabled,
  OPENCODE2_DIRECT_TOOL_OPTIONS,
  registerTodoTools,
  TODO_OUTPUT_SCHEMA,
} from "../src/opencode2/todo-tools.js"
import type { ToolDraft, ToolDefinition } from "../src/opencode2/types.js"

const originalTodosGate = process.env[DEVIN_OPENCODE2_TODOS_ENV]

function restoreTodosGate() {
  if (originalTodosGate === undefined) delete process.env[DEVIN_OPENCODE2_TODOS_ENV]
  else process.env[DEVIN_OPENCODE2_TODOS_ENV] = originalTodosGate
}

beforeEach(() => {
  clearAllSessionTodos()
})

afterEach(() => {
  restoreTodosGate()
})

describe("session todo store", () => {
  test("replace-all write then read", () => {
    const written = setSessionTodos("ses_1", [
      { content: "one", status: "in_progress", priority: "high" },
      { id: "keep", content: "two", status: "pending", priority: "low" },
    ])
    expect(written).toEqual([
      { id: "1", content: "one", status: "in_progress", priority: "high" },
      { id: "keep", content: "two", status: "pending", priority: "low" },
    ])
    expect(getSessionTodos("ses_1")).toEqual(written)
    expect(getSessionTodos("ses_other")).toEqual([])
  })

  test("drops empty content and fills defaults", () => {
    expect(normalizeSessionTodos([
      { content: "  " },
      { content: "ok" },
      null,
    ])).toEqual([
      { id: "1", content: "ok", status: "pending", priority: "medium" },
    ])
  })
})

describe("isOpenCode2TodosEnabled", () => {
  test("defaults off", () => {
    delete process.env[DEVIN_OPENCODE2_TODOS_ENV]
    expect(isOpenCode2TodosEnabled()).toBe(false)
  })

  test("force-enables on 1 or true", () => {
    process.env[DEVIN_OPENCODE2_TODOS_ENV] = "1"
    expect(isOpenCode2TodosEnabled()).toBe(true)
    process.env[DEVIN_OPENCODE2_TODOS_ENV] = "TRUE"
    expect(isOpenCode2TodosEnabled()).toBe(true)
  })

  test("stays off for other values", () => {
    process.env[DEVIN_OPENCODE2_TODOS_ENV] = "0"
    expect(isOpenCode2TodosEnabled()).toBe(false)
    process.env[DEVIN_OPENCODE2_TODOS_ENV] = "false"
    expect(isOpenCode2TodosEnabled()).toBe(false)
    process.env[DEVIN_OPENCODE2_TODOS_ENV] = "yes"
    expect(isOpenCode2TodosEnabled()).toBe(false)
  })
})

describe("registerTodoTools", () => {
  beforeEach(() => {
    process.env[DEVIN_OPENCODE2_TODOS_ENV] = "1"
  })

  test("adds todowrite and todoread when the host has neither", () => {
    const added: string[] = []
    const draft: ToolDraft = {
      add(tool) {
        added.push(tool.name)
      },
    }
    registerTodoTools(draft)
    expect(added).toEqual(["todowrite", "todoread"])
  })

  test("is a no-op when the gate is off", () => {
    delete process.env[DEVIN_OPENCODE2_TODOS_ENV]
    const added: string[] = []
    registerTodoTools({ add(tool) { added.push(tool.name) } })
    expect(added).toEqual([])
  })

  test("skips tools the host already owns", () => {
    const existing = new Set(["todowrite"])
    const added: string[] = []
    const stub = (name: string): ToolDefinition & { id: string } => ({
      id: name,
      name,
      description: "",
      input: {},
      execute: async () => ({}),
    })
    const draft: ToolDraft = {
      add(tool) {
        added.push(tool.name)
      },
      get(id) {
        return existing.has(id) ? stub(id) : undefined
      },
    }
    registerTodoTools(draft)
    expect(added).toEqual(["todoread"])
  })

  test("write then read through the registered execute path", async () => {
    const tools = new Map<string, ToolDefinition>()
    registerTodoTools({
      add(tool) {
        tools.set(tool.name, tool)
      },
    })
    const ctx = { sessionID: "ses_exec" }
    const written = await tools.get("todowrite")!.execute(
      { todos: [{ content: "ship", status: "in_progress", priority: "high" }] },
      ctx,
    )
    expect(written.content).toContain("ship")
    expect(written.output).toEqual({
      todos: [{ id: "1", content: "ship", status: "in_progress", priority: "high" }],
    })
    const read = await tools.get("todoread")!.execute({}, ctx)
    expect(JSON.parse(read.content)).toEqual([
      { id: "1", content: "ship", status: "in_progress", priority: "high" },
    ])
    expect(read.output).toEqual(written.output)
  })

  test("refuses a missing session id instead of sharing an empty-key list", async () => {
    const tools = new Map<string, ToolDefinition>()
    registerTodoTools({ add: (tool) => void tools.set(tool.name, tool) })
    expect(tools.get("todowrite")!.execute({ todos: [{ content: "unsafe" }] }, {}))
      .rejects.toThrow("did not provide a sessionID")
    expect(getSessionTodos("")).toEqual([])
  })

  test("registers as OpenCode 2 direct catalog tools with an output schema", () => {
    const tools = new Map<string, ToolDefinition>()
    registerTodoTools({
      add(tool) {
        tools.set(tool.name, tool)
      },
    })
    for (const name of ["todowrite", "todoread"] as const) {
      const tool = tools.get(name)!
      expect(tool.options).toEqual(OPENCODE2_DIRECT_TOOL_OPTIONS)
      expect(tool.output).toEqual(TODO_OUTPUT_SCHEMA)
    }
  })

  test("hostHasTool uses list() when get() is absent", () => {
    const draft: ToolDraft = {
      add() {},
      list: () => [{ id: "todowrite", name: "todowrite", description: "", input: {}, execute: async () => ({}) }],
    }
    expect(hostHasTool(draft, "todowrite")).toBe(true)
    expect(hostHasTool(draft, "todoread")).toBe(false)
  })
})
