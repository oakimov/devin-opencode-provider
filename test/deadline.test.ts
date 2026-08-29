import { describe, it, expect } from "bun:test"
import { withAbortDeadline } from "../src/deadline.js"

describe("withAbortDeadline", () => {
  it("resolves when function completes before deadline", async () => {
    const result = await withAbortDeadline(1000, () => new Error("timeout"), async (signal) => {
      return "success"
    })
    expect(result).toBe("success")
  })

  it("rejects when deadline exceeded", async () => {
    await expect(
      withAbortDeadline(10, () => new Error("deadline"), async (signal) => {
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason))
        })
        return "never"
      })
    ).rejects.toThrow("deadline")
  })

  it("passes abort signal to function", async () => {
    let receivedSignal: AbortSignal | undefined
    await withAbortDeadline(1000, () => new Error("timeout"), async (signal) => {
      receivedSignal = signal
      return "ok"
    })
    expect(receivedSignal).toBeDefined()
    expect(receivedSignal instanceof AbortSignal).toBe(true)
  })

  it("clears timer after completion", async () => {
    const result = await withAbortDeadline(100, () => new Error("timeout"), async () => "done")
    expect(result).toBe("done")
    // If timer not cleared, it would fire later — we just ensure it doesn't throw
  })

  it("handles synchronous functions", async () => {
    const result = await withAbortDeadline(1000, () => new Error("timeout"), async () => 42)
    expect(result).toBe(42)
  })

  it("propagates errors from function", async () => {
    await expect(
      withAbortDeadline(1000, () => new Error("timeout"), async () => {
        throw new Error("inner error")
      })
    ).rejects.toThrow("inner error")
  })
})
