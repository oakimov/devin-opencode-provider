import * as crypto from "node:crypto"
import { trace } from "../debug.js"
import { USER_STATUS_PATH } from "../shared.js"
import { buildCliMetadata, cascadeConnectHeaders } from "./metadata.js"
import { encodeMessage, iterFields } from "./wire.js"

/**
 * Seat plan snapshot from `SeatManagementService/GetUserStatus`.
 * Field numbers are the Cascade seat proto: response #1 UserStatus, #2 PlanInfo.
 * UserStatus #13 is PlanStatus. PlanInfo #2 is plan_name; monthly grants are
 * #12 prompt / #13 flow / #14 flex. PlanStatus balances are #6 used prompt,
 * #8 available prompt, #5/#9 flow, #7/#4 flex, #3 plan_end, #14/#15 quota percents.
 * Chat must not fail when this RPC fails.
 */
export type CreditBucket = { limit?: number; used?: number; available?: number }

export type SeatSnapshot = {
  planName?: string
  teamsTier?: number
  promptCredits?: CreditBucket
  flowCredits?: CreditBucket
  flexCredits?: CreditBucket
  planEndMs?: number
  dailyQuotaRemainingPercent?: number
  weeklyQuotaRemainingPercent?: number
  dailyQuotaResetAtUnix?: number
  weeklyQuotaResetAtUnix?: number
}

let latest: { host: string; snapshot: SeatSnapshot } | null = null

export function currentSeatSnapshot(host?: string): SeatSnapshot | undefined {
  if (!latest) return undefined
  if (host && latest.host !== host.replace(/\/$/, "")) return undefined
  return latest.snapshot
}

export function clearSeatSnapshot(): void {
  latest = null
}

function varint(value: bigint | number | Uint8Array): number | undefined {
  if (typeof value === "bigint" || typeof value === "number") {
    const n = Number(value)
    return Number.isSafeInteger(n) ? n : undefined
  }
  return undefined
}

function readString(fields: ReturnType<typeof iterFields>, num: number): string | undefined {
  for (const field of fields) {
    if (field.num === num && field.wire === 2 && field.value instanceof Uint8Array) {
      const text = new TextDecoder().decode(field.value).trim()
      if (text) return text
    }
  }
  return undefined
}

function readVar(fields: ReturnType<typeof iterFields>, num: number): number | undefined {
  for (const field of fields) {
    if (field.num === num && field.wire === 0) return varint(field.value)
  }
  return undefined
}

function readTimestampMs(fields: ReturnType<typeof iterFields>, num: number): number | undefined {
  for (const field of fields) {
    if (field.num !== num || field.wire !== 2 || !(field.value instanceof Uint8Array)) continue
    const inner = iterFields(field.value)
    const seconds = readVar(inner, 1)
    if (seconds === undefined) return undefined
    const nanos = readVar(inner, 2) ?? 0
    return seconds * 1000 + Math.floor(nanos / 1_000_000)
  }
  return undefined
}

function bucket(limit: number | undefined, used: number | undefined, available: number | undefined): CreditBucket | undefined {
  if (limit === undefined && used === undefined && available === undefined) return undefined
  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(used !== undefined ? { used } : {}),
    ...(available !== undefined ? { available } : {}),
  }
}

function applyPlanInfo(snapshot: SeatSnapshot, bytes: Uint8Array): void {
  const fields = iterFields(bytes)
  const planName = readString(fields, 2)
  const teamsTier = readVar(fields, 1)
  if (planName) snapshot.planName = planName
  if (teamsTier !== undefined && snapshot.teamsTier === undefined) snapshot.teamsTier = teamsTier
  const prompt = readVar(fields, 12)
  const flow = readVar(fields, 13)
  const flex = readVar(fields, 14)
  if (prompt !== undefined) snapshot.promptCredits = { ...snapshot.promptCredits, limit: prompt }
  if (flow !== undefined) snapshot.flowCredits = { ...snapshot.flowCredits, limit: flow }
  if (flex !== undefined) snapshot.flexCredits = { ...snapshot.flexCredits, limit: flex }
}

function applyPlanStatus(snapshot: SeatSnapshot, bytes: Uint8Array): void {
  const fields = iterFields(bytes)
  for (const field of fields) {
    if (field.num === 1 && field.wire === 2 && field.value instanceof Uint8Array) applyPlanInfo(snapshot, field.value)
  }
  const planEndMs = readTimestampMs(fields, 3)
  if (planEndMs !== undefined) snapshot.planEndMs = planEndMs
  const prompt = bucket(snapshot.promptCredits?.limit, readVar(fields, 6), readVar(fields, 8))
  const flow = bucket(snapshot.flowCredits?.limit, readVar(fields, 5), readVar(fields, 9))
  const flex = bucket(snapshot.flexCredits?.limit, readVar(fields, 7), readVar(fields, 4))
  if (prompt) snapshot.promptCredits = prompt
  if (flow) snapshot.flowCredits = flow
  if (flex) snapshot.flexCredits = flex
  const daily = readVar(fields, 14)
  const weekly = readVar(fields, 15)
  const dailyReset = readVar(fields, 17)
  const weeklyReset = readVar(fields, 18)
  if (daily !== undefined) snapshot.dailyQuotaRemainingPercent = daily
  if (weekly !== undefined) snapshot.weeklyQuotaRemainingPercent = weekly
  if (dailyReset !== undefined) snapshot.dailyQuotaResetAtUnix = dailyReset
  if (weeklyReset !== undefined) snapshot.weeklyQuotaResetAtUnix = weeklyReset
}

export function parseSeatSnapshot(buf: Uint8Array): SeatSnapshot | null {
  const snapshot: SeatSnapshot = {}
  const top = iterFields(buf)
  for (const field of top) {
    if (field.wire !== 2 || !(field.value instanceof Uint8Array)) continue
    if (field.num === 1) {
      const user = iterFields(field.value)
      const tier = readVar(user, 10)
      if (tier !== undefined) snapshot.teamsTier = tier
      for (const inner of user) {
        if (inner.num === 13 && inner.wire === 2 && inner.value instanceof Uint8Array) applyPlanStatus(snapshot, inner.value)
      }
    } else if (field.num === 2) {
      applyPlanInfo(snapshot, field.value)
    }
  }
  if (!snapshot.planName && snapshot.teamsTier === undefined && !snapshot.promptCredits && !snapshot.flowCredits && !snapshot.flexCredits) {
    return null
  }
  return snapshot
}

export function formatSeatSnapshot(snapshot: SeatSnapshot): string {
  const bucketText = (label: string, value: CreditBucket | undefined) => {
    if (!value) return ""
    return ` ${label}=${value.used ?? "?"}/${value.limit ?? "?"} avail=${value.available ?? "?"}`
  }
  return [
    "seat status:",
    `plan=${snapshot.planName ?? "-"}`,
    `tier=${snapshot.teamsTier ?? "-"}`,
    bucketText("prompt", snapshot.promptCredits).trim(),
    bucketText("flow", snapshot.flowCredits).trim(),
    bucketText("flex", snapshot.flexCredits).trim(),
    snapshot.planEndMs !== undefined ? `planEndMs=${snapshot.planEndMs}` : "",
    snapshot.dailyQuotaRemainingPercent !== undefined ? `dailyRemaining=${snapshot.dailyQuotaRemainingPercent}` : "",
    snapshot.weeklyQuotaRemainingPercent !== undefined ? `weeklyRemaining=${snapshot.weeklyQuotaRemainingPercent}` : "",
  ].filter(Boolean).join(" ")
}

export async function fetchSeatSnapshot(apiKey: string, host: string, signal?: AbortSignal): Promise<SeatSnapshot | null> {
  const base = host.replace(/\/$/, "")
  try {
    const metadata = buildCliMetadata({ apiKey, sessionId: crypto.randomUUID(), requestId: BigInt(Date.now()), triggerId: crypto.randomUUID() })
    const res = await fetch(`${base}${USER_STATUS_PATH}`, {
      method: "POST",
      headers: cascadeConnectHeaders("unary"),
      body: encodeMessage(1, metadata) as unknown as BodyInit,
      signal,
    })
    if (!res.ok) {
      trace(`seat status: HTTP ${res.status} host=${base}`)
      return null
    }
    const buf = new Uint8Array(await res.arrayBuffer())
    const snapshot = parseSeatSnapshot(buf)
    if (!snapshot) {
      trace(`seat status: empty host=${base} bytes=${buf.length}`)
      return null
    }
    latest = { host: base, snapshot }
    trace(formatSeatSnapshot(snapshot))
    return snapshot
  } catch (error) {
    trace(`seat status: failed ${(error as Error).message}`)
    return null
  }
}
