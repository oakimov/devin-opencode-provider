import { createSdk } from "./plugin-core.js"
import { DevinPlugin } from "./plugin.js"

export type CreateDevinOptions = {
  name?: string
  accessToken?: string
  apiKey?: string
  /** Windsurf/Devin API base — defaults to https://server.codeium.com */
  apiBaseURL?: string
  headers?: Record<string, string>
  /** Explicit cache dir override */
  cacheDir?: string
  /** Optional workspace root */
  workspaceRoot?: string
}

export function createDevin(options: CreateDevinOptions) {
  return createSdk(options)
}

// Back-compat naming: also expose createWindsurf
export const createWindsurf = createDevin
export const createCursor = createDevin

export { DevinPlugin }
export { DevinPlugin as WindsurfPlugin }
export default DevinPlugin
