import { trace } from "./debug.js"
import { DevinProtocolError, type DevinProviderError } from "./errors.js"

export type DevinContinuationOptions = {
  semanticIdleMs?: number
  hardCapMs?: number
  heartbeatMs?: number
}
export type DevinContinuationPolicy = { semanticIdleMs: number; hardCapMs: number; heartbeatMs: number }
export const DEFAULT_DEVIN_CONTINUATION_POLICY: Readonly<DevinContinuationPolicy> = {
  semanticIdleMs: 120_000,
  hardCapMs: 600_000,
  heartbeatMs: 5_000,
}
const MAX_TIMER_MS = 2_147_483_647
const DEFAULT_TOMBSTONE_TTL_MS = 15 * 60_000
const DEFAULT_TOMBSTONE_LIMIT = 1_024
const DEFAULT_MAX_OPEN_SESSIONS = 24

function positiveInteger(name: string, value: unknown, fallback: number): number {
  const resolved = value === undefined ? fallback : value
  if (typeof resolved !== "number" || !Number.isSafeInteger(resolved) || resolved <= 0 || resolved > MAX_TIMER_MS) {
    throw new DevinProtocolError(`Devin continuation ${name} must be a positive integer no greater than ${MAX_TIMER_MS}`)
  }
  return resolved
}
export function resolveDevinContinuationPolicy(options: DevinContinuationOptions | undefined): DevinContinuationPolicy {
  if (options !== undefined && (options === null || typeof options !== "object" || Array.isArray(options))) throw new DevinProtocolError("Devin continuation options must be an object")
  for (const key of Object.keys(options ?? {})) if (!["heartbeatMs", "semanticIdleMs", "hardCapMs"].includes(key)) throw new DevinProtocolError(`Unknown Devin continuation option: ${key}`)
  const heartbeatMs = positiveInteger("heartbeatMs", options?.heartbeatMs, DEFAULT_DEVIN_CONTINUATION_POLICY.heartbeatMs)
  const semanticIdleMs = positiveInteger("semanticIdleMs", options?.semanticIdleMs, DEFAULT_DEVIN_CONTINUATION_POLICY.semanticIdleMs)
  const hardCapMs = positiveInteger("hardCapMs", options?.hardCapMs, DEFAULT_DEVIN_CONTINUATION_POLICY.hardCapMs)
  if (heartbeatMs >= semanticIdleMs) throw new DevinProtocolError("Devin continuation heartbeatMs must be less than semanticIdleMs")
  if (semanticIdleMs > hardCapMs) throw new DevinProtocolError("Devin continuation semanticIdleMs must be no greater than hardCapMs")
  return { heartbeatMs, semanticIdleMs, hardCapMs }
}
export type DevinPendingExecState = "pending" | "claimed" | "delivered"
export type DevinPendingExec = { resultField: string; state: DevinPendingExecState; registeredAt: number; hardDeadlineAt: number; toolName?: string; resultMetadata?: Record<string, unknown>; bridged?: boolean }
export type DevinContinuationTerminalReason = "hard-cap-expired" | "remote-clean-close" | "remote-error" | "result-write-failed" | "ambiguous-partial-write" | "heartbeat-write-failed" | "reply-write-failed" | "process-disposed" | "superseded-by-new-run" | "open-session-cap-exceeded"
export type DevinSessionCloseReason = DevinContinuationTerminalReason | "ordinary-cleanup" | "turn-ended" | "initial-write-failed"
export type DevinSession = {
  sessionId: string
  conversationId: string
  cacheDir?: string
  openCodeSessionId?: string
  pending: Map<number, DevinPendingExec>
  displayToolCalls: Map<string, Record<string, unknown>>
  nextBridgedExecId: number
  blobs: Map<string, Uint8Array>
  allowTools: boolean
  policy: DevinContinuationPolicy
  createdAt: number
  lastInboundAt: number
  lastHeartbeatWriteAt: number
  semanticDeadlineAt: number
  closed: boolean
  closeError: DevinProviderError | null
}
type Tombstone = { reason: DevinContinuationTerminalReason | "delivered"; expiresAt: number }
export class DevinSessionManager {
  private byExecId = new Map<string, DevinSession>()
  private sessions = new Set<DevinSession>()
  private byOpenCodeSessionId = new Map<string, DevinSession>()
  private tombstones = new Map<string, Tombstone>()
  private readonly now: () => number
  private readonly tombstoneTtlMs: number
  private readonly tombstoneLimit: number
  private readonly maxOpenSessions: number
  constructor(options: { now?: () => number; tombstoneTtlMs?: number; tombstoneLimit?: number; maxOpenSessions?: number } = {}) {
    this.now = options.now ?? Date.now
    this.tombstoneTtlMs = positiveInteger("tombstoneTtlMs", options.tombstoneTtlMs, DEFAULT_TOMBSTONE_TTL_MS)
    this.tombstoneLimit = positiveInteger("tombstoneLimit", options.tombstoneLimit, DEFAULT_TOMBSTONE_LIMIT)
    this.maxOpenSessions = positiveInteger("maxOpenSessions", options.maxOpenSessions, DEFAULT_MAX_OPEN_SESSIONS)
  }
  private key(sessionId: string, execId: number): string { return `${sessionId}:${execId}` }
  registerSession(session: DevinSession): void {
    if (session.closed) throw new DevinProtocolError("Cannot register a closed Devin session")
    if (this.sessions.has(session)) return
    this.sessions.add(session)
    if (session.openCodeSessionId) {
      const prior = this.byOpenCodeSessionId.get(session.openCodeSessionId)
      if (prior && prior !== session && !prior.closed) {
        trace(`devin sessionManager: superseding stale ${prior.sessionId} with ${session.sessionId}`)
        this.close(prior, "superseded-by-new-run")
      }
      this.byOpenCodeSessionId.set(session.openCodeSessionId, session)
    }
    this.enforceCap(session)
  }
  private enforceCap(justRegistered: DevinSession): void {
    while (this.sessions.size > this.maxOpenSessions) {
      let oldest: DevinSession | undefined
      for (const c of this.sessions) { if (c !== justRegistered && (!oldest || c.createdAt < oldest.createdAt)) oldest = c }
      if (!oldest) return
      trace(`devin sessionManager: cap exceeded (${this.sessions.size} > ${this.maxOpenSessions}), closing ${oldest.sessionId}`)
      this.close(oldest, "open-session-cap-exceeded")
    }
  }
  close(session: DevinSession, reason: DevinSessionCloseReason = "ordinary-cleanup", error?: DevinProviderError): void {
    if (session.closed) return
    session.closed = true
    session.closeError = error ?? session.closeError ?? null
    trace(`devin sessionManager.close: reason=${reason} pending=${session.pending.size}`)
    for (const id of session.pending.keys()) {
      const key = this.key(session.sessionId, id)
      this.byExecId.delete(key)
      if (!["ordinary-cleanup", "turn-ended", "initial-write-failed"].includes(reason)) this.putTombstone(key, reason as DevinContinuationTerminalReason)
    }
    session.pending.clear()
    session.displayToolCalls?.clear()
    session.blobs?.clear()
    this.sessions.delete(session)
    if (session.openCodeSessionId && this.byOpenCodeSessionId.get(session.openCodeSessionId) === session) this.byOpenCodeSessionId.delete(session.openCodeSessionId)
  }
  closeUnlessPending(session: DevinSession): boolean {
    if (session.closed) return true
    if (session.pending.size > 0) { trace(`devin sessionManager.closeUnlessPending: KEEP pending=${session.pending.size}`); return false }
    this.close(session, "ordinary-cleanup")
    return true
  }
  private putTombstone(key: string, reason: DevinContinuationTerminalReason | "delivered"): void {
    this.tombstones.set(key, { reason, expiresAt: this.now() + this.tombstoneTtlMs })
    while (this.tombstones.size > this.tombstoneLimit) { const oldest = this.tombstones.keys().next().value as string | undefined; if (!oldest) break; this.tombstones.delete(oldest) }
  }
}
export const devinSessionManager = new DevinSessionManager()
