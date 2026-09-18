import { describe, expect, it } from "bun:test"
import {
  advertisedToolNames,
  hostShellTool,
  hostTaskTool,
  remapEmittedToolCall,
  remapHostToolName,
} from "../src/protocol/host-dialect.js"

describe("host shell/task dialect", () => {
  it("prefers bash when both shell tools are advertised", () => {
    expect(hostShellTool(["bash", "shell"])).toBe("bash")
    expect(hostShellTool(["shell"])).toBe("shell")
  })

  it("prefers task when both executors are advertised", () => {
    expect(hostTaskTool(["task", "subagent"])).toBe("task")
    expect(hostTaskTool(["subagent"])).toBe("subagent")
    expect(hostTaskTool(["bash"])).toBeUndefined()
  })

  it("remaps bash/execute onto OpenCode 2 shell", () => {
    const advertised = advertisedToolNames([{ name: "shell" }, { name: "read" }])
    expect(remapHostToolName("bash", advertised)).toBe("shell")
    expect(remapHostToolName("execute", advertised)).toBe("shell")
    expect(remapHostToolName("shell", advertised)).toBe("shell")
  })

  it("rewrites task args onto OpenCode 2 subagent", () => {
    const advertised = new Set(["subagent"])
    const remapped = remapEmittedToolCall(
      "task",
      { description: "review", prompt: "look", subagent_type: "explore", task_id: "abc", background: true },
      advertised,
    )
    expect(remapped.toolName).toBe("subagent")
    expect(remapped.args).toEqual({
      agent: "explore",
      description: "review",
      prompt: "look",
      sessionID: "abc",
      background: true,
    })
  })

  it("rewrites subagent args onto OpenCode 1.x task", () => {
    const advertised = new Set(["task"])
    const remapped = remapEmittedToolCall(
      "subagent",
      { agent: "explore", description: "review", prompt: "look", sessionID: "abc" },
      advertised,
    )
    expect(remapped.toolName).toBe("task")
    expect(remapped.args).toEqual({
      description: "review",
      prompt: "look",
      subagent_type: "explore",
      task_id: "abc",
    })
  })
})
