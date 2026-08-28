import type { DevinProviderError } from "./errors.js"
import { trace } from "./debug.js"

export type ReplayBarrierReason =
  | "visible-text"
  | "visible-reasoning"
  | "display-tool-lifecycle"
  | "non-control-exec"
  | "stateful-interaction"
  | "unknown-or-malformed-frame"

export class DevinAttemptReplaySafety {
  private barrierReason: ReplayBarrierReason | undefined
  constructor(private readonly sessionId: string) {}
  markBarrier(reason: ReplayBarrierReason): void {
    if (this.barrierReason) return
    this.barrierReason = reason
    trace(`devin replay barrier: reason=${reason} sessionId=${this.sessionId}`)
  }
  applyTo(failure: DevinProviderError): DevinProviderError {
    failure.replaySafe = this.barrierReason === undefined && failure.replaySafe
    if (this.barrierReason) trace(`devin replay suppressed: reason=${this.barrierReason} sessionId=${this.sessionId}`)
    return failure
  }
}
