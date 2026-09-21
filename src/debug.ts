import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Wire-level diagnostics. Opt in with DEVIN_PROVIDER_DEBUG=1 (or "true").
// Managed default: $TMPDIR/devin-provider-logs-<uid>/debug-<pid>.log
// with directory mode 0o700 and file mode 0o600. Override with DEVIN_PROVIDER_DEBUG_FILE.
// First init in a fresh file writes a header; later inits (module reload / second
// isolate sharing DEVIN_PROVIDER_DEBUG_FILE) append another header instead of
// wiping earlier lines. Operators who want a clean run should truncate the
// override path before starting the host. Independently, when the file reaches
// DEBUG_LOG_MAX_BYTES it is size-capped (truncated + new header) so debug runs
// cannot grow without bound. Tokens / checksums: redact in callers.
const DEBUG_ENABLED =
  process.env.DEVIN_PROVIDER_DEBUG === "1" ||
  process.env.DEVIN_PROVIDER_DEBUG === "true"

/** Soft cap for the debug log file; exceeded size triggers truncate + new header. */
export const DEBUG_LOG_MAX_BYTES = 10 * 1024 * 1024

let _traceInitialized = false
let _debugFile: string | undefined
let _debugFileUsesManagedDirectory = false
let _announcedLogPath = false

/** Whether `DEVIN_PROVIDER_DEBUG` is enabled for this process. */
export function isDebugEnabled(): boolean {
  return DEBUG_ENABLED
}

/** Resolve the debug log path (env override or per-uid tmpdir default). */
export function resolveDebugLogPath(): string {
  if (process.env.DEVIN_PROVIDER_DEBUG_FILE) {
    return process.env.DEVIN_PROVIDER_DEBUG_FILE
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : process.pid
  return path.join(os.tmpdir(), `devin-provider-logs-${uid}`, `debug-${process.pid}.log`)
}

/**
 * Ensure the log directory is 0o700 and the log file exists as 0o600.
 * Does **not** truncate an existing file — mid-run re-init must keep prior lines.
 * Exported for tests; callers normally go through `trace`.
 */
export function ensureSecureDebugLog(
  filePath: string,
  options: { secureParent?: boolean } = {},
): void {
  const dir = path.dirname(filePath)
  const secureParent = options.secureParent ?? true
  fs.mkdirSync(dir, secureParent
    ? { recursive: true, mode: 0o700 }
    : { recursive: true })
  if (secureParent) {
    const stat = fs.lstatSync(dir)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Debug log directory is not a real directory: ${dir}`)
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error(`Debug log directory is not owned by the current user: ${dir}`)
    }
    fs.chmodSync(dir, 0o700)
  }
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "", { mode: 0o600 })
  }
  fs.chmodSync(filePath, 0o600)
}

function announceLogPath(filePath: string): void {
  if (_announcedLogPath) return
  _announcedLogPath = true
  try {
    // Visible in the OpenCode / terminal session so operators know where to look.
    console.error(`[devin-provider] DEVIN_PROVIDER_DEBUG logging to ${filePath}`)
  } catch {
    /* ignore */
  }
}

function debugBannerLine(): string {
  return `--- devin-provider debug (pid ${process.pid}) ${new Date().toISOString()} ---\n`
}

/**
 * If `filePath` is at least `maxBytes`, truncate it and write a size-cap header.
 * Returns true when a truncate happened. Exported for tests.
 */
export function truncateDebugLogIfOversized(
  filePath: string,
  maxBytes: number = DEBUG_LOG_MAX_BYTES,
): boolean {
  if (!fs.existsSync(filePath)) return false
  const size = fs.statSync(filePath).size
  if (size < maxBytes) return false
  fs.writeFileSync(
    filePath,
    debugBannerLine() +
      `[${new Date().toISOString()}] debug: size-cap truncate ` +
      `wasBytes=${size} maxBytes=${maxBytes}\n`,
    { mode: 0o600 },
  )
  fs.chmodSync(filePath, 0o600)
  return true
}

export function trace(msg: string): void {
  if (!DEBUG_ENABLED) return
  try {
    if (!_debugFile) {
      _debugFileUsesManagedDirectory = !process.env.DEVIN_PROVIDER_DEBUG_FILE
      _debugFile = resolveDebugLogPath()
    }
    if (!_traceInitialized) {
      ensureSecureDebugLog(_debugFile, { secureParent: _debugFileUsesManagedDirectory })
      // Drop oversized leftovers from a prior run before appending a reinit banner.
      truncateDebugLogIfOversized(_debugFile)
      const banner = debugBannerLine()
      const preexisting =
        fs.existsSync(_debugFile) && fs.statSync(_debugFile).size > 0
      if (preexisting) {
        fs.appendFileSync(_debugFile, banner)
      } else {
        fs.writeFileSync(_debugFile, banner, { mode: 0o600 })
      }
      _traceInitialized = true
      announceLogPath(_debugFile)
      fs.appendFileSync(
        _debugFile,
        `[${new Date().toISOString()}] debug: enabled` +
          (preexisting ? " reinit=append" : "") +
          `\n`,
      )
    }
    truncateDebugLogIfOversized(_debugFile)
    fs.appendFileSync(_debugFile, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    /* ignore */
  }
}
