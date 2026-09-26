import * as crypto from "node:crypto"
import { concat, encodeMessage, encodeString, encodeVarintField } from "./wire.js"

/**
 * Metadata proto (exa.codeium_common_pb.Metadata).
 *
 * Two client identities:
 * - `cli` (default): released Devin CLI — ideName `devin-cli`, ideType `chisel`,
 *   versions `3000.6.2`. This identity is what unlocks `AssignModel` and the
 *   CLI model surface.
 * - `windsurf`: Devin Desktop / Windsurf extension capture (3.6.27 / 1.48.2).
 *   Rollback via `DEVIN_CLIENT_IDENTITY=windsurf`.
 *
 * Discovery (`GetCliModelConfigs`) uses a separate dev-channel identity:
 * ideName/extensionName `chisel`, versions `0.0.0-dev`, plus the native
 * display-slot advertisement. That identity is not the chat identity.
 *
 * `Metadata.userJwt` is field 21. `Metadata.apiKey` always carries the
 * `devin-session-token$` prefix the CLI wire requires.
 */

export const SESSION_TOKEN_PREFIX = "devin-session-token$"

export const CLI_IDE_NAME = "devin-cli"
export const CLI_IDE_TYPE = "chisel"
export const CLI_VERSION = "3000.6.2"
export const DISCOVERY_VERSION = "0.0.0-dev"
export const CLI_USER_AGENT = `devin-cli/${CLI_VERSION}`

/** Display slots the native CLI advertises on discovery Metadata field 30. */
export const DISCOVERY_DISPLAY_SLOTS = [3, 4, 6, 7, 8] as const
/** Requested, then hidden from the OpenCode picker (quick-review, internal-default). */
export const INTERNAL_DISPLAY_SLOTS = new Set<number>([4, 6])
export const DISPLAY_MODEL_ROUTER = 3

export type ClientIdentity = "cli" | "windsurf"

export type MetadataOpts = {
  apiKey: string
  userJwt?: string
  sessionId?: string
  requestId?: bigint
  triggerId?: string
  extensionVersion?: string
  ideVersion?: string
  /** Defaults to `DEVIN_CLIENT_IDENTITY`, which defaults to `cli`. */
  identity?: ClientIdentity
}

let requestCounter = BigInt(Date.now())

/** `Metadata.os` vocabulary. `process.platform` is fixed for the process lifetime. */
export function cascadeOs(): "darwin" | "windows" | "linux" {
  if (process.platform === "darwin") return "darwin"
  if (process.platform === "win32") return "windows"
  return "linux"
}

export function resolveClientIdentity(raw = process.env.DEVIN_CLIENT_IDENTITY): ClientIdentity {
  const value = raw?.trim().toLowerCase()
  if (value === "windsurf" || value === "desktop") return "windsurf"
  return "cli"
}

/** Session token as the CLI wire carries it: the scheme prefix is required. */
export function normalizeSessionToken(apiKey: string | undefined): string {
  if (!apiKey) return ""
  return apiKey.startsWith(SESSION_TOKEN_PREFIX) ? apiKey : `${SESSION_TOKEN_PREFIX}${apiKey}`
}

function freshIds(opts: MetadataOpts): { requestId: bigint; sessionId: string; triggerId: string } {
  return {
    requestId: opts.requestId ?? ++requestCounter,
    sessionId: opts.sessionId ?? crypto.randomUUID(),
    triggerId: opts.triggerId ?? crypto.randomUUID(),
  }
}

function timestampMessage(): Uint8Array {
  const now = Date.now()
  const seconds = Math.floor(now / 1000)
  const nanos = (now % 1000) * 1_000_000
  return concat(encodeVarintField(1, seconds), encodeVarintField(2, nanos))
}

function commonTail(opts: MetadataOpts, ids: { requestId: bigint; sessionId: string; triggerId: string }): Uint8Array[] {
  const parts: Uint8Array[] = [
    encodeVarintField(9, ids.requestId),
    encodeString(10, ids.sessionId),
    encodeMessage(16, timestampMessage()),
    encodeString(25, ids.triggerId),
  ]
  if (opts.userJwt) parts.push(encodeString(21, opts.userJwt))
  return parts
}

/** Released Devin CLI Metadata (`GetUserJwt`, `AssignModel`, `GetChatMessage`, `GetUserStatus`). */
export function buildCliMetadata(opts: MetadataOpts): Uint8Array {
  const ids = freshIds(opts)
  const extVer = opts.extensionVersion ?? CLI_VERSION
  const ideVer = opts.ideVersion ?? CLI_VERSION
  return concat(
    encodeString(1, CLI_IDE_NAME),
    encodeString(2, extVer),
    encodeString(3, normalizeSessionToken(opts.apiKey)),
    encodeString(4, "en"),
    encodeString(5, cascadeOs()),
    encodeString(7, ideVer),
    encodeString(12, CLI_IDE_TYPE),
    encodeString(28, CLI_IDE_TYPE),
    ...commonTail(opts, ids),
  )
}

/**
 * Dev-channel Metadata for `GetCliModelConfigs`.
 * ideName and extensionName are `chisel`; versions are `0.0.0-dev`.
 */
export function buildDiscoveryMetadata(opts: MetadataOpts & { displaySlots?: readonly number[] }): Uint8Array {
  const ids = freshIds(opts)
  const extVer = opts.extensionVersion ?? DISCOVERY_VERSION
  const ideVer = opts.ideVersion ?? DISCOVERY_VERSION
  const slots = opts.displaySlots ?? DISCOVERY_DISPLAY_SLOTS
  return concat(
    encodeString(1, CLI_IDE_TYPE),
    encodeString(2, extVer),
    encodeString(3, normalizeSessionToken(opts.apiKey)),
    encodeString(4, "en"),
    encodeString(5, cascadeOs()),
    encodeString(7, ideVer),
    encodeString(12, CLI_IDE_TYPE),
    ...slots.map((slot) => encodeVarintField(30, slot)),
    ...commonTail(opts, ids),
  )
}

/** Devin Desktop / Windsurf Metadata. Kept for `DEVIN_CLIENT_IDENTITY=windsurf`. */
export function buildWindsurfMetadata(opts: MetadataOpts): Uint8Array {
  const ids = freshIds(opts)
  const extVer = opts.extensionVersion ?? "1.48.2"
  const ideVer = opts.ideVersion ?? "3.6.27"
  const parts: Uint8Array[] = [
    encodeString(1, "windsurf"),
    encodeString(2, extVer),
    encodeString(3, normalizeSessionToken(opts.apiKey)),
    encodeString(4, "en"),
    encodeString(5, "mac"),
    encodeString(7, ideVer),
    encodeString(12, "windsurf"),
    encodeMessage(16, timestampMessage()),
    encodeString(17, "/Applications/Devin.app/Contents/Resources/app/extensions/windsurf"),
    encodeString(24, "bff6620ec042c87de64f90510a56cb9915175588fd2f3de5978646ed3ac54c5aeec74d0e7ef6b92857e33e1a68bb05620f4cac513dbdb400cdbc1c89aa74c322"),
    encodeString(25, ids.triggerId),
    encodeString(26, "Free"),
    encodeString(28, "windsurf"),
    encodeVarintField(9, ids.requestId),
    encodeString(10, ids.sessionId),
  ]
  if (opts.userJwt) parts.push(encodeString(21, opts.userJwt))
  return concat(...parts)
}

export function buildMetadata(opts: MetadataOpts): Uint8Array {
  const identity = opts.identity ?? resolveClientIdentity()
  return identity === "windsurf" ? buildWindsurfMetadata(opts) : buildCliMetadata(opts)
}

/** Unary stays `application/proto`. Streams stay Connect-framed gzip. */
export function cascadeConnectHeaders(mode: "unary" | "stream"): Record<string, string> {
  const headers: Record<string, string> = {
    "Connect-Protocol-Version": "1",
    Accept: "*/*",
  }
  if (mode === "unary") {
    headers["Content-Type"] = "application/proto"
  } else {
    headers["Content-Type"] = "application/connect+proto"
    headers["Connect-Content-Encoding"] = "gzip"
    headers["Connect-Accept-Encoding"] = "gzip"
  }
  if (resolveClientIdentity() === "cli") headers["User-Agent"] = CLI_USER_AGENT
  return headers
}
