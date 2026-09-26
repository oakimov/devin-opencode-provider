import { WINDSURF_API_HOST } from "./shared.js"

/** Public Cascade host. Enterprise tenants replace this via JWT `customApiServerUrl`. */
export const PUBLIC_CASCADE_ORIGIN = `https://${WINDSURF_API_HOST}`

/**
 * Host precedence for chat, discovery, and `AssignModel`:
 * 1. `DEVIN_API_BASE_URL`
 * 2. `WINDSURF_API_BASE_URL` (legacy alias)
 * 3. A configured base that is not the public Cascade origin
 * 4. `GetUserJwt` field 2 `customApiServerUrl`
 * 5. Public Cascade origin
 *
 * `GetUserJwt` itself is always minted against (1), else (2), else the
 * configured base, else the public origin — never against the custom URL
 * the response has not returned yet.
 */
export function normalizeApiBase(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim()
  if (!trimmed) return undefined
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return undefined
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined
  const path = url.pathname.replace(/\/+$/, "")
  return `${url.origin}${path === "/" ? "" : path}`
}

export function explicitCascadeBaseOverride(): string | undefined {
  return normalizeApiBase(process.env.DEVIN_API_BASE_URL) ?? normalizeApiBase(process.env.WINDSURF_API_BASE_URL)
}

export function cascadeMintHost(configured?: string): string {
  return explicitCascadeBaseOverride() ?? normalizeApiBase(configured) ?? PUBLIC_CASCADE_ORIGIN
}

export function resolveCascadeApiBase(input: { configured?: string; customApiServerUrl?: string } = {}): string {
  const explicit = explicitCascadeBaseOverride()
  if (explicit) return explicit
  const configured = normalizeApiBase(input.configured)
  if (configured && configured !== PUBLIC_CASCADE_ORIGIN) return configured
  const custom = normalizeApiBase(input.customApiServerUrl)
  if (custom) return custom
  return configured ?? PUBLIC_CASCADE_ORIGIN
}
