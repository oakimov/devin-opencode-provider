import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import * as ShellTimeout from "../src/shell-timeout.js"

describe("shell-timeout module", () => {
  beforeEach(() => {
    ShellTimeout.resetDevinShellCalls()
  })

  afterEach(() => {
    ShellTimeout.resetDevinShellCalls()
  })

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

  it("devinShellEnvForCommand is a no-op without a pending wrap", () => {
    expect(ShellTimeout.devinShellEnvForCommand("echo hi", "/tmp")).toBeUndefined()
  })
})

describe("shell env correlation", () => {
  const spawn = (cwd: string) => ({
    background_shell_spawn: true,
    command: "echo hi",
    working_directory: cwd,
  })

  beforeEach(() => {
    ShellTimeout.resetDevinShellCalls()
    ShellTimeout.setDevinShellPath("/bin/bash")
  })

  afterEach(() => {
    ShellTimeout.resetDevinShellCalls()
  })

  it("gives identical commands in different directories their own injector", () => {
    ShellTimeout.registerDevinShellCall("devin_a", spawn("/tmp/a"))
    ShellTimeout.registerDevinShellCall("devin_b", spawn("/tmp/b"))
    const argsA: Record<string, unknown> = {}
    const argsB: Record<string, unknown> = {}
    ShellTimeout.prepareDevinShellArgs("devin_a", argsA)
    ShellTimeout.prepareDevinShellArgs("devin_b", argsB)
    expect(ShellTimeout.devinShellEnvForCommand("echo hi")).toBeUndefined()
    const envA = ShellTimeout.devinShellEnvForCommand("echo hi", "/tmp/a")
    const envB = ShellTimeout.devinShellEnvForCommand("echo hi", "/tmp/b")
    expect(envA?.BASH_ENV).toBeTruthy()
    expect(envB?.BASH_ENV).toBeTruthy()
    expect(envA?.BASH_ENV).not.toBe(envB?.BASH_ENV)
  })

  it("stamps a no-op suffix when two wraps share a command and directory", () => {
    if (process.platform === "win32") return
    ShellTimeout.registerDevinShellCall("devin_a", spawn("/tmp"))
    ShellTimeout.registerDevinShellCall("devin_b", spawn("/tmp"))
    const argsA: Record<string, unknown> = {}
    const argsB: Record<string, unknown> = {}
    ShellTimeout.prepareDevinShellArgs("devin_a", argsA)
    ShellTimeout.prepareDevinShellArgs("devin_b", argsB)
    expect(argsA.command).toBe("echo hi")
    expect(String(argsB.command)).toContain("devin-shell:devin_b")
    const envA = ShellTimeout.devinShellEnvForCommand(String(argsA.command), "/tmp")
    const envB = ShellTimeout.devinShellEnvForCommand(String(argsB.command), "/tmp")
    expect(envA?.BASH_ENV).toBeTruthy()
    expect(envB?.BASH_ENV).toBeTruthy()
    expect(envA?.BASH_ENV).not.toBe(envB?.BASH_ENV)
  })

  it("uses the stamped timeout to tell identical commands apart", () => {
    const soft = {
      shell_stream: true,
      timeout_behavior: ShellTimeout.DEVIN_TIMEOUT_BACKGROUND,
      command: "echo hi",
      working_directory: "/tmp",
      timeout_ms: 1_000,
    }
    ShellTimeout.registerDevinShellCall("devin_a", soft)
    ShellTimeout.registerDevinShellCall("devin_b", soft)
    const argsA: Record<string, unknown> = {}
    const argsB: Record<string, unknown> = {}
    ShellTimeout.prepareDevinShellArgs("devin_a", argsA)
    ShellTimeout.prepareDevinShellArgs("devin_b", argsB)
    expect(argsA.timeout).not.toBe(argsB.timeout)

    const envA = ShellTimeout.devinShellEnvForCommand("echo hi", "/tmp", { timeout: argsA.timeout as number })
    const envB = ShellTimeout.devinShellEnvForCommand("echo hi", "/tmp", { timeout: argsB.timeout as number })
    expect(envA?.BASH_ENV).toBeTruthy()
    expect(envB?.BASH_ENV).toBeTruthy()
    expect(envA?.BASH_ENV).not.toBe(envB?.BASH_ENV)
  })

  it("returns no injector when a timeout hint still matches more than one wrap", () => {
    const soft = (cwd: string) => ({
      shell_stream: true,
      timeout_behavior: ShellTimeout.DEVIN_TIMEOUT_BACKGROUND,
      command: "echo hi",
      working_directory: cwd,
      timeout_ms: 1_000,
    })
    ShellTimeout.registerDevinShellCall("devin_a", soft("/tmp/a"))
    ShellTimeout.registerDevinShellCall("devin_b", soft("/tmp/b"))
    const argsA: Record<string, unknown> = {}
    const argsB: Record<string, unknown> = {}
    ShellTimeout.prepareDevinShellArgs("devin_a", argsA)
    ShellTimeout.prepareDevinShellArgs("devin_b", argsB)
    expect(argsA.timeout).not.toBe(1)
    expect(argsB.timeout).not.toBe(1)
    expect(ShellTimeout.devinShellEnvForCommand("echo hi", undefined, { timeout: 1 })).toBeUndefined()
  })
})
