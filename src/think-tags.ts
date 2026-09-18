/**
 * Split Muse/Qwen/SWE in-band `<think>…</think>` out of visible content.
 *
 * Devin's GetChatMessage maps structured reasoning to proto #9, but several
 * models still emit the XML tags on #3 (visible text). Passing those through
 * as text-delta is what surfaces a literal `</think>` in OpenCode.
 *
 * Algorithm matches cursor_mock/llm/client.py `_feed_think_tags` (cross-chunk
 * hold of partial tags) plus stray `</think>` with no matching open: drop the
 * tag, and treat any prefix as reasoning until the first visible text.
 */

export const THINK_OPEN = "<think>"
export const THINK_CLOSE = "</think>"

export type ThinkTagEvent = { kind: "text" | "reasoning"; text: string }

export type ThinkTagState = {
  open: boolean
  buf: string
  /** True until a non-empty visible-text event is produced. */
  beforeVisibleText: boolean
}

export function newThinkTagState(): ThinkTagState {
  return { open: false, buf: "", beforeVisibleText: true }
}

/** Longest suffix of `buf` that is a proper prefix of `tag`. */
export function thinkTagHoldLen(buf: string, tag: string): number {
  const maxK = Math.min(buf.length, tag.length - 1)
  for (let k = maxK; k > 0; k--) {
    if (tag.startsWith(buf.slice(-k))) return k
  }
  return 0
}

function push(out: ThinkTagEvent[], kind: ThinkTagEvent["kind"], text: string, state: ThinkTagState): void {
  if (!text) return
  out.push({ kind, text })
  if (kind === "text") state.beforeVisibleText = false
}

function earliestTag(text: string, from: number): { tag: string; index: number } | null {
  const openAt = text.indexOf(THINK_OPEN, from)
  const closeAt = text.indexOf(THINK_CLOSE, from)
  if (openAt < 0 && closeAt < 0) return null
  if (openAt < 0) return { tag: THINK_CLOSE, index: closeAt }
  if (closeAt < 0) return { tag: THINK_OPEN, index: openAt }
  return openAt <= closeAt
    ? { tag: THINK_OPEN, index: openAt }
    : { tag: THINK_CLOSE, index: closeAt }
}

export function feedThinkTags(chunk: string, state: ThinkTagState): ThinkTagEvent[] {
  const events: ThinkTagEvent[] = []
  const text = state.buf + chunk
  state.buf = ""
  let i = 0
  const n = text.length
  while (i < n) {
    if (state.open) {
      const j = text.indexOf(THINK_CLOSE, i)
      if (j < 0) {
        const hold = thinkTagHoldLen(text.slice(i), THINK_CLOSE)
        const flushEnd = n - hold
        if (flushEnd > i) push(events, "reasoning", text.slice(i, flushEnd), state)
        state.buf = text.slice(flushEnd)
        break
      }
      if (j > i) push(events, "reasoning", text.slice(i, j), state)
      state.open = false
      i = j + THINK_CLOSE.length
      continue
    }
    const hit = earliestTag(text, i)
    if (!hit) {
      const hold = Math.max(
        thinkTagHoldLen(text.slice(i), THINK_OPEN),
        thinkTagHoldLen(text.slice(i), THINK_CLOSE),
      )
      const flushEnd = n - hold
      if (flushEnd > i) push(events, "text", text.slice(i, flushEnd), state)
      state.buf = text.slice(flushEnd)
      break
    }
    if (hit.index > i) {
      const prefix = text.slice(i, hit.index)
      if (hit.tag === THINK_CLOSE && state.beforeVisibleText) {
        push(events, "reasoning", prefix, state)
      } else {
        push(events, "text", prefix, state)
      }
    }
    if (hit.tag === THINK_OPEN) {
      state.open = true
      i = hit.index + THINK_OPEN.length
    } else {
      // Stray close (no matching open): drop the tag.
      state.open = false
      i = hit.index + THINK_CLOSE.length
    }
  }
  return events
}

export function flushThinkTags(state: ThinkTagState): ThinkTagEvent[] {
  const leftover = state.buf
  state.buf = ""
  if (!leftover) return []
  const kind = state.open || state.beforeVisibleText ? "reasoning" : "text"
  // Partial tag at EOS is still markup; do not surface it as visible text.
  if (THINK_OPEN.startsWith(leftover) || THINK_CLOSE.startsWith(leftover)) {
    state.open = false
    return []
  }
  const events: ThinkTagEvent[] = []
  push(events, kind, leftover, state)
  state.open = false
  return events
}

/** Non-streaming split for history replay. */
export function splitThinkDocument(raw: string): { thinking: string; text: string } {
  const state = newThinkTagState()
  const events = [...feedThinkTags(raw, state), ...flushThinkTags(state)]
  const thinking = events.filter((e) => e.kind === "reasoning").map((e) => e.text).join("")
  const text = events.filter((e) => e.kind === "text").map((e) => e.text).join("")
  return { thinking, text }
}
