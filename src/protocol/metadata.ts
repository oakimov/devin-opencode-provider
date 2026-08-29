import * as crypto from "node:crypto"
import { concat, encodeMessage, encodeString, encodeVarintField } from "./wire.js"

/**
 * Build Windsurf Metadata proto (exa.codeium_common_pb.Metadata)
 * Minimal load-bearing fields derived from rsvedant CLOUD_DIRECT and devin_mock.
 *
 * VERSION DEPENDENCIES:
 * =====================
 * The hardcoded version strings below are derived from Devin IDE decompilation (v3.7.25).
 * These values should be updated when Devin releases significant protocol changes:
 *
 * - extensionVersion: "1.48.2" - Windsurf extension version
 * - ideVersion: "3.6.27" - Devin IDE version
 * - Platform: "mac" - Hardcoded to macOS for protocol compatibility
 * - Extension path: macOS-specific Devin.app path
 * - Plan type: "Free" - May need updates for Pro/Enterprise plan differences
 *
 * These values are used for protocol compatibility and may affect:
 * - Feature availability (some features require specific IDE versions)
 * - Rate limiting and quota enforcement
 * - Protocol field acceptance (server may reject unknown versions)
 *
 * To update: Capture new values from Devin IDE decompilation or network traces,
 * then update the defaults in buildMetadata() and document the protocol changes.
 */

export type MetadataOpts = {
  apiKey: string
  userJwt?: string
  sessionId?: string
  requestId?: bigint
  triggerId?: string
  extensionVersion?: string
  ideVersion?: string
}

let requestCounter = BigInt(Date.now())

export function buildMetadata(opts: MetadataOpts): Uint8Array {
  const requestId = opts.requestId ?? ++requestCounter
  const sessionId = opts.sessionId ?? crypto.randomUUID()
  const triggerId = opts.triggerId ?? crypto.randomUUID()
  // VERSION ALIGNMENT NOTE:
  // These hardcoded versions match a specific Devin IDE release (3.6.27) that was used
  // to capture and reverse-engineer the protocol. Changing these may cause the API to
  // reject requests or return different behavior. The values should be updated if:
  // 1. Devin deprecates this IDE version
  // 2. The protocol changes significantly
  // 3. Server-side validation becomes stricter
  // 
  // Current versions (verified against Devin IDE 3.6.27 decompiled):
  // - Extension: 1.48.2 (windsurf extension version)
  // - IDE: 3.6.27 (Devin Desktop version)
  // - Platform: mac (hardcoded for consistency)
  // - Plan: Free (may affect available models/features)
  //
  // To update: capture new IDE release, decompile, and extract these values from
  // the Metadata proto construction in the official client.
  const extVer = opts.extensionVersion ?? "1.48.2"
  const ideVer = opts.ideVersion ?? "3.6.27"

  const now = Date.now()
  const seconds = Math.floor(now / 1000)
  const nanos = (now % 1000) * 1_000_000

  const tsInner = concat(
    encodeVarintField(1, seconds),
    encodeVarintField(2, nanos),
  )

  const parts: Uint8Array[] = []
  parts.push(encodeString(1, "windsurf"))
  parts.push(encodeString(2, extVer))
  parts.push(encodeString(3, opts.apiKey))
  parts.push(encodeString(4, "en"))
  parts.push(encodeString(5, "mac"))
  parts.push(encodeString(7, ideVer))
  parts.push(encodeVarintField(9, requestId))
  parts.push(encodeString(10, sessionId))
  parts.push(encodeString(12, "windsurf"))
  parts.push(encodeMessage(16, tsInner))
  parts.push(encodeString(17, "/Applications/Devin.app/Contents/Resources/app/extensions/windsurf"))
  parts.push(encodeString(24, "bff6620ec042c87de64f90510a56cb9915175588fd2f3de5978646ed3ac54c5aeec74d0e7ef6b92857e33e1a68bb05620f4cac513dbdb400cdbc1c89aa74c322"))
  parts.push(encodeString(25, triggerId))
  parts.push(encodeString(26, "Free"))
  parts.push(encodeString(28, "windsurf"))
  // user_jwt if mint available — some endpoints require it via Metadata? Kept as extra
  if (opts.userJwt) {
    // field 15 or so? For now keep in api_key already; user_jwt passed separately in some flows.
  }
  return concat(...parts)
}
