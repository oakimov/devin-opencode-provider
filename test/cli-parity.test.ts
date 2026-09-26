import { afterEach, describe, expect, it } from "bun:test"
import { APICallError } from "@ai-sdk/provider"
import { resolveCascadeApiBase } from "../src/api-base.js"
import { parseGetUserJwtBody } from "../src/auth.js"
import { devinContextOverflowError } from "../src/errors.js"
import { modelsToConfig } from "../src/model-config.js"
import {
  catalogDisposition,
  discoveryRpcOrder,
  modelRequiresAssignModel,
  parseCascadeModelConfigs,
  resolveDevinWireModelId,
  type ModelInfo,
} from "../src/models.js"
import { encodeAssignModelRequest, parseAssignModelResponse } from "../src/protocol/assign.js"
import {
  buildGetChatMessageRequest,
  decodeChatFrame,
  isLargeHistoryOverflow,
  LARGE_HISTORY_OVERFLOW_BYTES,
  shrinkableHistoryBytes,
  type ChatHistoryItem,
} from "../src/protocol/chat.js"
import { isGeminiWireUid, normalizeToolSchemaForGemini } from "../src/protocol/gemini-schema.js"
import { parseSeatSnapshot } from "../src/protocol/seat-status.js"
import { concat, encodeMessage, encodeString, encodeTag, encodeVarintField, iterFields } from "../src/protocol/wire.js"

const saved: Record<string, string | undefined> = {}

function setEnv(name: string, value: string | undefined) {
  if (!(name in saved)) saved[name] = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
    delete saved[name]
  }
})

function strings(buf: Uint8Array, num: number): string[] {
  const out: string[] = []
  for (const field of iterFields(buf)) {
    if (field.num === num && field.wire === 2 && field.value instanceof Uint8Array) {
      out.push(new TextDecoder().decode(field.value))
    }
  }
  return out
}

function encodeDouble(fieldNum: number, value: number): Uint8Array {
  const tag = encodeTag(fieldNum, 1)
  const body = new Uint8Array(8)
  new DataView(body.buffer).setFloat64(0, value, true)
  return concat(tag, body)
}

function clientConfig(input: {
  uid: string
  label?: string
  disabled?: boolean
  displayOption?: number
  isModelRouter?: boolean
  harnessUids?: string[]
}): Uint8Array {
  const info: Uint8Array[] = []
  for (const harness of input.harnessUids ?? []) info.push(encodeString(20, harness))
  if (input.displayOption !== undefined) info.push(encodeVarintField(22, input.displayOption))
  if (input.isModelRouter) info.push(encodeVarintField(25, 1))
  return encodeMessage(1, concat(
    encodeString(1, input.label ?? input.uid),
    ...(input.disabled ? [encodeVarintField(4, 1)] : []),
    encodeString(22, input.uid),
    ...(info.length ? [encodeMessage(23, concat(...info))] : []),
  ))
}

describe("Cascade API base", () => {
  it("lets DEVIN_API_BASE_URL win over the JWT custom host", () => {
    setEnv("DEVIN_API_BASE_URL", "https://explicit.example/cascade/")
    setEnv("WINDSURF_API_BASE_URL", "https://legacy.example")
    expect(resolveCascadeApiBase({
      configured: "https://server.codeium.com",
      customApiServerUrl: "https://tenant.example",
    })).toBe("https://explicit.example/cascade")
  })

  it("uses the legacy env alias, then a non-public configured base, then the JWT host", () => {
    setEnv("DEVIN_API_BASE_URL", undefined)
    setEnv("WINDSURF_API_BASE_URL", "https://legacy.example")
    expect(resolveCascadeApiBase({ customApiServerUrl: "https://tenant.example" })).toBe("https://legacy.example")
    setEnv("WINDSURF_API_BASE_URL", undefined)
    expect(resolveCascadeApiBase({
      configured: "https://private.example",
      customApiServerUrl: "https://tenant.example",
    })).toBe("https://private.example")
    expect(resolveCascadeApiBase({
      configured: "https://server.codeium.com",
      customApiServerUrl: "https://tenant.example/",
    })).toBe("https://tenant.example")
    expect(resolveCascadeApiBase({ customApiServerUrl: "not a url" })).toBe("https://server.codeium.com")
  })

  it("parses GetUserJwt field 2", () => {
    const body = concat(
      encodeString(1, "eyJhbGciOiJub25lIn0.eyJleHAiOjE3MDAwMDAwMDB9.c2ln"),
      encodeString(2, "https://tenant.example"),
    )
    expect(parseGetUserJwtBody(body)).toEqual({
      jwt: "eyJhbGciOiJub25lIn0.eyJleHAiOjE3MDAwMDAwMDB9.c2ln",
      customApiServerUrl: "https://tenant.example",
    })
  })
})

describe("discovery order and catalog classification", () => {
  it("calls GetCliModelConfigs first for the CLI identity", () => {
    expect(discoveryRpcOrder("cli")[0]).toContain("GetCliModelConfigs")
    expect(discoveryRpcOrder("windsurf")[0]).toContain("GetCascadeModelConfigs")
  })

  it("classifies routers, fusion composites, and hidden display slots", () => {
    expect(catalogDisposition({ modelUid: "subagent-default" })).toBe("subagent")
    expect(catalogDisposition({ modelUid: "adaptive", isModelRouter: true })).toBe("assign-router")
    expect(catalogDisposition({ modelUid: "adaptive", displayOption: 3 })).toBe("assign-router")
    expect(catalogDisposition({
      modelUid: "fusion",
      isModelRouter: true,
      harnessUids: ["lead"],
    })).toBe("fusion")
    expect(catalogDisposition({ modelUid: "review", displayOption: 4 })).toBe("internal")
    expect(catalogDisposition({ modelUid: "internal", displayOption: 6 })).toBe("internal")
    expect(catalogDisposition({ modelUid: "swe-1-6-slow", displayOption: 8 })).toBe("chat")
    expect(catalogDisposition({ modelUid: "hidden", disabled: true })).toBe("disabled")

    const parsed = parseCascadeModelConfigs(concat(
      clientConfig({ uid: "adaptive", label: "Adaptive Max", isModelRouter: true, displayOption: 3 }),
      clientConfig({ uid: "fusion", isModelRouter: true, harnessUids: ["claude-lead"] }),
      clientConfig({ uid: "quick", displayOption: 4 }),
      clientConfig({ uid: "subagent-default", isModelRouter: true }),
      clientConfig({ uid: "swe-1-6-slow", label: "SWE 1.6", displayOption: 8 }),
    ))
    expect(parsed.map((model) => model.id)).toEqual(["adaptive", "swe-1-6-slow"])
    expect(parsed[0]?.requiresAssignModel).toBe(true)
    expect(parsed[1]?.requiresAssignModel).toBeUndefined()
  })

  it("keeps AssignModel routers out of effort ladders", () => {
    const models: ModelInfo[] = [
      { id: "claude-opus-5-medium", displayName: "Claude Opus Medium", variants: [] },
      { id: "claude-opus-5-max", displayName: "Claude Opus Max", variants: [] },
      { id: "adaptive", displayName: "Adaptive Max", requiresAssignModel: true, variants: [] },
    ]
    const config = modelsToConfig(models)
    expect(config.adaptive.variants).toBeUndefined()
    expect(config.adaptive.name).toBe("Adaptive Max")
    expect(modelRequiresAssignModel("adaptive")).toBe(true)
    expect(resolveDevinWireModelId(undefined, "adaptive", [{ id: "effort", value: "max" }])).toBe("adaptive")
    expect(Object.values(config).some((entry) => entry && typeof entry === "object" && "variants" in (entry as object))).toBe(true)
  })
})

describe("AssignModel and chat request", () => {
  const base = {
    apiKey: "k",
    userJwt: "jwt",
    modelUid: "claude-opus-5-medium",
    cascadeId: "cascade-stable",
    promptId: "prompt-1",
    sessionId: "session-stable",
    promptCacheKey: "cache-key-1",
    requestId: 1n,
    triggerId: "trig",
  }

  it("encodes the router prompt and reads the assignment", () => {
    const req = encodeAssignModelRequest({
      apiKey: "k",
      modelRouterUid: "adaptive",
      cascadeId: "cascade-stable",
      userText: "ship the parser",
      sessionId: "session-stable",
      requestId: 1n,
      triggerId: "trig",
    })
    expect(strings(req, 2)).toEqual(["adaptive"])
    expect(strings(req, 3)).toEqual(["cascade-stable"])
    const prompt = [...iterFields(req)].find((field) => field.num === 5 && field.value instanceof Uint8Array)
    expect(prompt).toBeTruthy()
    const promptFields = iterFields(prompt!.value as Uint8Array)
    expect(promptFields.some((field) => field.num === 1)).toBe(false)
    expect(strings(prompt!.value as Uint8Array, 3)).toEqual(["ship the parser"])
    const metadata = [...iterFields(req)].find((field) => field.num === 1 && field.value instanceof Uint8Array)
    expect(strings(metadata!.value as Uint8Array, 21)).toEqual([])
    expect(strings(metadata!.value as Uint8Array, 1)).toEqual(["devin-cli"])

    const response = encodeMessage(1, concat(
      encodeString(1, "assignment-jwt"),
      encodeString(2, "MODEL_PRIVATE_9"),
    ))
    expect(parseAssignModelResponse(response)).toEqual({
      assignmentJwt: "assignment-jwt",
      modelUid: "MODEL_PRIVATE_9",
    })
  })

  it("puts the assignment JWT and ephemeral cache options on the chat request", () => {
    const msgs: ChatHistoryItem[] = [{ role: "user", content: "hi" }]
    const req = buildGetChatMessageRequest({
      ...base,
      messages: msgs,
      modelUid: "MODEL_PRIVATE_9",
      modelAssignmentJwt: "assignment-jwt",
      normalizeGeminiTools: true,
      tools: [{
        name: "zeta",
        description: "Z",
        parameters: {
          type: "object",
          properties: { n: { type: ["number", "null"], nullable: true } },
        },
      }],
    })
    expect(strings(req, 21)).toEqual(["MODEL_PRIVATE_9"])
    expect(strings(req, 26)).toEqual(["assignment-jwt"])
    expect(strings(req, 27)).toEqual(["cache-key-1"])
    const cache = [...iterFields(req)].find((field) => field.num === 13 && field.value instanceof Uint8Array)
    expect(cache).toBeTruthy()
    const cacheType = [...iterFields(cache!.value as Uint8Array)].find((field) => field.num === 1 && field.wire === 0)
    expect(Number(cacheType?.value)).toBe(1)
    const tool = [...iterFields(req)].find((field) => field.num === 10 && field.value instanceof Uint8Array)
    const schema = strings(tool!.value as Uint8Array, 3)[0] ?? ""
    expect(schema).toContain('"type":"number"')
    expect(schema).not.toContain("null")
    expect(schema).not.toContain("nullable")
    const metadata = [...iterFields(req)].find((field) => field.num === 1 && field.value instanceof Uint8Array)
    expect(strings(metadata!.value as Uint8Array, 21)).toEqual(["jwt"])
  })
})

describe("Gemini tool schema", () => {
  it("collapses nullable type unions", () => {
    expect(isGeminiWireUid("MODEL_GOOGLE_GEMINI_2_5")).toBe(true)
    expect(isGeminiWireUid("gemini-2.5-pro")).toBe(true)
    expect(isGeminiWireUid("claude-opus-5")).toBe(false)
    expect(normalizeToolSchemaForGemini({
      type: "object",
      properties: {
        n: { type: ["number", "null"], nullable: true },
        items: { type: "array", items: { type: ["string", "null"] } },
      },
    })).toEqual({
      type: "object",
      properties: {
        n: { type: "number" },
        items: { type: "array", items: { type: "string" } },
      },
    })
  })
})

describe("stream credits and overflow", () => {
  it("decodes credit fields and the routed model uid without touching token usage", () => {
    const frame = concat(
      encodeVarintField(14, 12),
      encodeVarintField(18, 9),
      encodeDouble(22, 1.5),
      encodeString(23, "MODEL_PRIVATE_9"),
      encodeMessage(7, concat(encodeVarintField(2, 100), encodeVarintField(3, 20))),
    )
    const events = [...decodeChatFrame(frame)]
    expect(events).toContainEqual({ kind: "actual_model", uid: "MODEL_PRIVATE_9" })
    expect(events).toContainEqual({
      kind: "credits",
      creditCost: 12,
      committedCreditCost: 9,
      committedAcuCost: 1.5,
    })
    expect(events).toContainEqual({
      kind: "usage",
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
      cachedTokens: undefined,
    })
  })

  it("maps an early invalid_argument on a large history to context overflow", () => {
    const history = "x".repeat(LARGE_HISTORY_OVERFLOW_BYTES)
    const request = buildGetChatMessageRequest({
      apiKey: "k",
      userJwt: "jwt",
      modelUid: "m",
      cascadeId: "c",
      promptId: "p",
      sessionId: "s",
      requestId: 1n,
      triggerId: "t",
      messages: [
        { role: "assistant", content: history },
        { role: "user", content: "continue" },
      ],
    })
    const historyBytes = shrinkableHistoryBytes(request)
    expect(historyBytes).toBeGreaterThanOrEqual(LARGE_HISTORY_OVERFLOW_BYTES)
    expect(isLargeHistoryOverflow({
      code: "invalid_argument",
      message: "internal error",
      historyBytes,
      emittedOutput: false,
    })).toBe(true)
    expect(isLargeHistoryOverflow({
      code: "invalid_argument",
      message: "internal error",
      historyBytes,
      emittedOutput: true,
    })).toBe(false)
    expect(isLargeHistoryOverflow({
      code: "unavailable",
      message: "internal error",
      historyBytes,
      emittedOutput: false,
    })).toBe(false)
    expect(isLargeHistoryOverflow({
      code: "invalid_argument",
      message: "permission denied",
      historyBytes,
      emittedOutput: false,
    })).toBe(false)
    expect(isLargeHistoryOverflow({
      code: "invalid_argument",
      message: "internal error",
      historyBytes: LARGE_HISTORY_OVERFLOW_BYTES - 1,
      emittedOutput: false,
    })).toBe(false)
    const error = devinContextOverflowError("history", "https://server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage")
    expect(APICallError.isInstance(error)).toBe(true)
    expect(error.isRetryable).toBe(false)
    expect(error.message).toContain("prompt is too long")
    expect(error.responseBody).toContain("context_length_exceeded")
  })
})

describe("seat status", () => {
  it("maps plan name, credit buckets, and quota windows", () => {
    const planInfo = concat(
      encodeString(2, "Devin Pro"),
      encodeVarintField(12, 1000),
      encodeVarintField(13, 200),
      encodeVarintField(14, 50),
    )
    const planStatus = concat(
      encodeMessage(1, planInfo),
      encodeMessage(3, encodeVarintField(1, 1_700_000_000)),
      encodeVarintField(6, 10),
      encodeVarintField(8, 990),
      encodeVarintField(5, 4),
      encodeVarintField(9, 196),
      encodeVarintField(7, 1),
      encodeVarintField(4, 49),
      encodeVarintField(14, 80),
      encodeVarintField(15, 70),
      encodeVarintField(17, 1_700_000_100),
      encodeVarintField(18, 1_700_000_200),
    )
    const response = concat(
      encodeMessage(1, concat(encodeVarintField(10, 9), encodeMessage(13, planStatus))),
      encodeMessage(2, planInfo),
    )
    expect(parseSeatSnapshot(response)).toEqual({
      planName: "Devin Pro",
      teamsTier: 9,
      promptCredits: { limit: 1000, used: 10, available: 990 },
      flowCredits: { limit: 200, used: 4, available: 196 },
      flexCredits: { limit: 50, used: 1, available: 49 },
      planEndMs: 1_700_000_000_000,
      dailyQuotaRemainingPercent: 80,
      weeklyQuotaRemainingPercent: 70,
      dailyQuotaResetAtUnix: 1_700_000_100,
      weeklyQuotaResetAtUnix: 1_700_000_200,
    })
  })
})
