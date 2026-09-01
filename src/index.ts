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

export { DevinPlugin }
export default DevinPlugin

// Keep root runtime exports plugin-safe. OpenCode's legacy plugin loader
// treats package-root exports as potential plugins, so extra public runtime
// APIs belong on subpaths such as "devin-opencode-provider/errors".
//
// Windsurf/Cursor aliases are retained for back-compat on subpath
// "devin-opencode-provider/compat" — see src/compat.ts — but are NOT
// re-exported here so pi-bridge's `createXxx` / `*Plugin` auto-detection
// sees a single factory and a single plugin, like cursor-opencode-provider.
