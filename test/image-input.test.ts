import { describe, it, expect } from "bun:test"
import { hasDevinUserImages, MAX_DEVIN_IMAGE_INPUT_BYTES } from "../src/image-input.js"

describe("hasDevinUserImages", () => {
  it("returns true for user message with file image part", () => {
    const lastUser: any = { role: "user", content: [{ type: "file", mediaType: "image/png", filename: "a.png" }] }
    expect(hasDevinUserImages(lastUser)).toBe(true)
  })

  it("returns false for text-only content", () => {
    expect(hasDevinUserImages({ role: "user", content: [{ type: "text", text: "hi" }] } as any)).toBe(false)
  })

  it("returns false for undefined or non-array content", () => {
    expect(hasDevinUserImages(undefined)).toBe(false)
    expect(hasDevinUserImages({ role: "user", content: "hi" } as any)).toBe(false)
  })

  it("ignores non-image file parts", () => {
    const lastUser: any = { role: "user", content: [{ type: "file", mediaType: "application/pdf" }] }
    expect(hasDevinUserImages(lastUser)).toBe(false)
  })
})

describe("MAX_DEVIN_IMAGE_INPUT_BYTES", () => {
  it("is 20 MiB", () => {
    expect(MAX_DEVIN_IMAGE_INPUT_BYTES).toBe(20 * 1024 * 1024)
  })
})

describe("image-input module contract", () => {
  it("exports expected symbols", async () => {
    const mod = await import("../src/image-input.js")
    expect(typeof mod.extractDevinPromptImages).toBe("function")
    expect(typeof mod.assertDevinUserImageSupport).toBe("function")
    expect(typeof mod.hasDevinUserImages).toBe("function")
  })

  it("assertDevinUserImageSupport throws when unsupported but images present", async () => {
    const mod = await import("../src/image-input.js")
    const lastUser: any = { role: "user", content: [{ type: "file", mediaType: "image/png" }] }
    expect(() => mod.assertDevinUserImageSupport(lastUser, false, "op-test")).toThrow()
  })

  it("assert allows when supported", async () => {
    const mod = await import("../src/image-input.js")
    const lastUser: any = { role: "user", content: [{ type: "file", mediaType: "image/png" }] }
    expect(() => mod.assertDevinUserImageSupport(lastUser, true, "op-test")).not.toThrow()
  })

  it("assert does not throw when no images even if unsupported", async () => {
    const mod = await import("../src/image-input.js")
    const lastUser: any = { role: "user", content: [{ type: "text", text: "hi" }] }
    expect(() => mod.assertDevinUserImageSupport(lastUser, false, "op-test")).not.toThrow()
  })
})
