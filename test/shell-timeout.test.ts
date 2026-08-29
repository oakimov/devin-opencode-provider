import { describe, it, expect } from "bun:test"
import * as ShellTimeout from "../src/shell-timeout.js"

describe("shell-timeout module", () => {
  it("exports expected symbols", () => {
    expect(typeof ShellTimeout).toBe("object")
    expect(Object.keys(ShellTimeout).length).toBeGreaterThan(0)
  })

  it("exposes timeout constants", () => {
    expect(ShellTimeout.DEVIN_TIMEOUT_CANCEL).toBe(1)
    expect(ShellTimeout.DEVIN_TIMEOUT_BACKGROUND).toBe(2)
    expect(typeof ShellTimeout.BACKGROUND_SHELL_MARKER).toBe("string")
  })

  it("exports policy and outcome types (runtime check)", () => {
    expect(ShellTimeout.BACKGROUND_SHELL_MARKER).toContain("BACKGROUND")
  })
})
