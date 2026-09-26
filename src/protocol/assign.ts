import { DevinProviderError } from "../errors.js"
import { cascadeConnectHeaders, buildCliMetadata } from "./metadata.js"
import { concat, encodeMessage, encodeString, encodeVarintField, iterFields } from "./wire.js"

export const ASSIGN_MODEL_PATH = "/exa.api_server_pb.ApiServerService/AssignModel"

export type ModelAssignment = { modelUid: string; assignmentJwt: string }

/**
 * `AssignModelRequest`:
 * 1 Metadata (CLI identity, no user JWT — the session token alone),
 * 2 model_router_uid,
 * 3 cascade_id (must match the following GetChatMessage),
 * 5 ChatMessagePrompt for the current user turn only (empty message id).
 *
 * `AssignModelResponse.assignment` is field 1:
 * 1 assignment_jwt, 2 model_uid.
 */
export function encodeRouterPrompt(text: string): Uint8Array {
  return concat(
    encodeVarintField(2, 1),
    encodeString(3, text),
  )
}

export function encodeAssignModelRequest(args: {
  apiKey: string
  modelRouterUid: string
  cascadeId: string
  userText?: string
  sessionId?: string
  requestId?: bigint
  triggerId?: string
}): Uint8Array {
  const metadata = buildCliMetadata({
    apiKey: args.apiKey,
    sessionId: args.sessionId,
    requestId: args.requestId,
    triggerId: args.triggerId,
  })
  const parts: Uint8Array[] = [
    encodeMessage(1, metadata),
    encodeString(2, args.modelRouterUid),
    encodeString(3, args.cascadeId),
  ]
  const text = args.userText?.trim()
  if (text) parts.push(encodeMessage(5, encodeRouterPrompt(text)))
  return concat(...parts)
}

export function parseAssignModelResponse(buf: Uint8Array): ModelAssignment | null {
  for (const field of iterFields(buf)) {
    if (field.num !== 1 || field.wire !== 2 || !(field.value instanceof Uint8Array)) continue
    let assignmentJwt = ""
    let modelUid = ""
    for (const inner of iterFields(field.value)) {
      if (inner.wire !== 2 || !(inner.value instanceof Uint8Array)) continue
      const text = new TextDecoder().decode(inner.value).trim()
      if (inner.num === 1) assignmentJwt = text
      else if (inner.num === 2) modelUid = text
    }
    if (assignmentJwt && modelUid) return { assignmentJwt, modelUid }
  }
  return null
}

export async function assignCascadeModel(args: {
  apiKey: string
  host: string
  modelRouterUid: string
  cascadeId: string
  userText?: string
  signal?: AbortSignal
}): Promise<ModelAssignment> {
  const proto = encodeAssignModelRequest(args)
  const host = args.host.replace(/\/$/, "")
  let res: Response
  try {
    res = await fetch(`${host}${ASSIGN_MODEL_PATH}`, {
      method: "POST",
      headers: cascadeConnectHeaders("unary"),
      body: proto as unknown as BodyInit,
      signal: args.signal,
    })
  } catch (cause) {
    throw new DevinProviderError(`AssignModel network failed for ${args.modelRouterUid}`, {
      transient: false,
      cause,
    })
  }
  const buf = new Uint8Array(await res.arrayBuffer())
  if (!res.ok) {
    const snippet = new TextDecoder().decode(buf).slice(0, 400)
    throw new DevinProviderError(`AssignModel HTTP ${res.status} for ${args.modelRouterUid}: ${snippet}`, {
      code: String(res.status),
      transient: false,
    })
  }
  const assignment = parseAssignModelResponse(buf)
  if (!assignment) {
    throw new DevinProviderError(
      `AssignModel returned no assignment JWT and model uid for ${args.modelRouterUid}`,
      { transient: false },
    )
  }
  return assignment
}
