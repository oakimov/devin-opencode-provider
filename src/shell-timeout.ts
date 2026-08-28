import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, delimiter, join } from "node:path"

/** Devin agent.v1 TimeoutBehavior enum values. */
export const DEVIN_TIMEOUT_CANCEL = 1
export const DEVIN_TIMEOUT_BACKGROUND = 2

const MAX_TRACKED_SHELL_CALLS = 512
const OPENCODE_TIMEOUT_GRACE_MS = 15_000
const POLL_INTERVAL_MS = 100
const BACKGROUND_MARKER = "__DEVIN_SHELL_BACKGROUND__"
const EXIT_MARKER = "__DEVIN_SHELL_EXIT__"
const TIMEOUT_MARKER = "__DEVIN_SHELL_TIMEOUT__"
/** Private marker for Devin `background_shell_spawn_args` detach wrappers. */
export const BACKGROUND_SHELL_MARKER = "__DEVIN_BACKGROUND_SHELL__"

export type DevinShellPolicy = {
  command: string
  workingDirectory: string
  timeoutMs: number
  timeoutBehavior: number
  hardTimeoutMs?: number
  /** Immediate nohup detach for Devin `background_shell_spawn_args`. */
  backgroundSpawn?: boolean
}

export type DevinShellOutcome =
  | { kind: "exit"; code: number }
  | { kind: "timeout"; timeoutMs: number }
  | {
      kind: "backgrounded"
      shellId: number
      pid: number
      command: string
      workingDirectory: string
      msToWait: number
      reason: 1
    }

type DevinShellEnvWrap = {
  env: Record<string, string>
  wrapperPath: string
  cleanup: () => void
}

const policies = new Map<string, DevinShellPolicy>()
const outcomes = new Map<string, DevinShellOutcome>()
/** callIDs that need shell.env injectors or a direct-command fallback. */
const pendingEnvWraps = new Set<string>()
const activeEnvWraps = new Map<string, DevinShellEnvWrap>()
let configuredShell: string | undefined

/** Track OpenCode's configured shell from the classic config hook. */
export function setDevinShellPath(shell: string | undefined): void {
  configuredShell = shell?.trim() || undefined
}

function executableOnPath(name: string): boolean {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return true
  }
  return false
}

/**
 * Mirror the relevant part of OpenCode Shell.acceptable(): fish/nu are denied,
 * then POSIX falls back to bash when installed and `/bin/sh` otherwise.
 */
export function resolveDevinShellKind(
  shell = configuredShell ?? process.env.SHELL,
): "bash" | "zsh" | "sh" | "dash" | "other" {
  let name = shell ? basename(shell).toLowerCase().replace(/\.exe$/, "") : ""
  if (name === "fish" || name === "nu" || !name) {
    name = executableOnPath("bash") ? "bash" : "sh"
  }
  if (name === "bash" || name === "zsh" || name === "sh" || name === "dash") return name
  return "other"
}

function remember<T>(map: Map<string, T>, key: string, value: T, onEvict?: (value: T) => void): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > MAX_TRACKED_SHELL_CALLS) {
    const oldest = map.keys().next().value as string | undefined
    if (!oldest) break
    const evicted = map.get(oldest)
    map.delete(oldest)
    if (evicted !== undefined && onEvict) onEvict(evicted)
  }
}

function finiteNonNegative(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(n) || n < 0) return undefined
  return Math.floor(n)
}

export function shellPolicyFromMetadata(
  metadata: Record<string, unknown> | undefined,
): DevinShellPolicy | undefined {
  if (!metadata) return undefined
  if (metadata.background_shell_spawn === true) {
    return {
      command: typeof metadata.command === "string" ? metadata.command : "",
      workingDirectory:
        typeof metadata.working_directory === "string" ? metadata.working_directory : "",
      timeoutMs: 0,
      timeoutBehavior: 0,
      backgroundSpawn: true,
    }
  }
  if (metadata.shell_stream !== true) return undefined
  const timeoutMs = finiteNonNegative(metadata.timeout_ms) ?? 30_000
  const timeoutBehavior = finiteNonNegative(metadata.timeout_behavior) ?? 0
  const hardTimeoutMs = finiteNonNegative(metadata.hard_timeout_ms)
  return {
    command: typeof metadata.command === "string" ? metadata.command : "",
    workingDirectory:
      typeof metadata.working_directory === "string" ? metadata.working_directory : "",
    timeoutMs,
    timeoutBehavior,
    ...(hardTimeoutMs !== undefined && hardTimeoutMs > 0 ? { hardTimeoutMs } : {}),
  }
}

/** Register a Devin shell request before OpenCode executes its emitted tool call. */
export function registerDevinShellCall(
  toolCallId: string,
  metadata: Record<string, unknown> | undefined,
): void {
  const policy = shellPolicyFromMetadata(metadata)
  if (!policy || !toolCallId.startsWith("devin_")) return
  remember(policies, toolCallId, policy)
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * F11 / soft-background helper.
 *
 * Run a Devin soft-background command for its foreground window, then leave
 * it detached (`nohup`) if still alive. The sentinel is removed by the after
 * hook before OpenCode stores/renders the result.
 *
 * This approximates Devin's TIMEOUT_BACKGROUND semantics through OpenCode's
 * foreground-only bash tool. Residual: after OpenCode returns, the child (and
 * optional hard-timeout watchdog) may still be running; this provider does not
 * reap leftover processes — cleanup is left to the user / OS.
 */
export function buildSoftBackgroundCommand(policy: DevinShellPolicy): string {
  const polls = Math.ceil(policy.timeoutMs / POLL_INTERVAL_MS)
  const hardPolls = policy.hardTimeoutMs !== undefined
    ? Math.max(1, Math.ceil(policy.hardTimeoutMs / POLL_INTERVAL_MS))
    : undefined
  const lines = [
    'devin_shell_log="$(mktemp "${TMPDIR:-/tmp}/devin-opencode-shell.XXXXXX")" || exit 1',
    `nohup sh -c ${shellQuote(policy.command)} >"$devin_shell_log" 2>&1 </dev/null &`,
    "devin_shell_pid=$!",
  ]
  if (hardPolls !== undefined) {
    lines.push(
      'devin_shell_status="$(mktemp "${TMPDIR:-/tmp}/devin-opencode-shell-status.XXXXXX")" || exit 1',
      `nohup sh -c 'devin_hard_poll=0; while [ "$devin_hard_poll" -lt "$1" ] && kill -0 "$2" 2>/dev/null; do sleep ${POLL_INTERVAL_MS / 1000}; devin_hard_poll=$((devin_hard_poll + 1)); done; if kill -0 "$2" 2>/dev/null; then printf timeout >"$3"; kill -TERM "$2" 2>/dev/null; sleep 3; kill -KILL "$2" 2>/dev/null; fi' devin-shell-watchdog ${hardPolls} "$devin_shell_pid" "$devin_shell_status" >/dev/null 2>&1 </dev/null &`,
      "devin_shell_watchdog_pid=$!",
    )
  } else {
    lines.push('devin_shell_status=""', 'devin_shell_watchdog_pid=""')
  }
  lines.push(
    // Avoid interactive job-control noise ("Terminated: 15 …") when we later
    // reap the watchdog; that text can otherwise land after our private marker
    // and leak into OpenCode's bash UI.
    "set +m 2>/dev/null || true",
    'if [ -n "$devin_shell_watchdog_pid" ]; then disown "$devin_shell_watchdog_pid" 2>/dev/null || true; fi',
    'disown "$devin_shell_pid" 2>/dev/null || true',
    "devin_shell_poll=0",
    `while [ "$devin_shell_poll" -lt ${polls} ] && kill -0 "$devin_shell_pid" 2>/dev/null; do`,
    `  sleep ${POLL_INTERVAL_MS / 1000}`,
    "  devin_shell_poll=$((devin_shell_poll + 1))",
    "done",
    'if kill -0 "$devin_shell_pid" 2>/dev/null; then',
    '  cat "$devin_shell_log"',
    `  printf '\n${BACKGROUND_MARKER}%s:%s\n' "$devin_shell_pid" "$devin_shell_log"`,
    "  exit 0",
    "fi",
    'wait "$devin_shell_pid" 2>/dev/null',
    "devin_shell_code=$?",
    'cat "$devin_shell_log"',
    'if [ -n "$devin_shell_status" ] && [ "$(cat "$devin_shell_status" 2>/dev/null)" = timeout ]; then',
    // Reap the watchdog before printing the private marker so any residual
    // shell diagnostics cannot trail the sentinel.
    '  if [ -n "$devin_shell_watchdog_pid" ]; then kill "$devin_shell_watchdog_pid" 2>/dev/null || true; wait "$devin_shell_watchdog_pid" 2>/dev/null || true; fi',
    `  printf '\n${TIMEOUT_MARKER}%s\n' ${policy.hardTimeoutMs ?? policy.timeoutMs}`,
    "else",
    '  if [ -n "$devin_shell_watchdog_pid" ]; then kill "$devin_shell_watchdog_pid" 2>/dev/null || true; wait "$devin_shell_watchdog_pid" 2>/dev/null || true; fi',
    `  printf '\n${EXIT_MARKER}%s\n' "$devin_shell_code"`,
    "fi",
    'rm -f -- "$devin_shell_log"',
    'if [ -n "$devin_shell_status" ]; then rm -f -- "$devin_shell_status"; fi',
  )
  return lines.join("\n")
}

/**
 * F11 / background_shell_spawn_args helper.
 *
 * OpenCode's bash tool is foreground-only. Detach the requested command inside
 * that one foreground call (`nohup … &`) and print a private marker containing
 * the spawned PID and log path. With stdin and all output redirected, the host
 * shell can return immediately instead of retaining OpenCode's tool pipe.
 *
 * Residual: the detached child is not reaped by this provider after OpenCode
 * completes the tool call; cleanup is left to the user / OS.
 */
export function buildBackgroundShellCommand(command: string): string {
  return [
    'bg_log="$(mktemp "${TMPDIR:-/tmp}/devin-opencode-bg.XXXXXX")" || exit 1',
    `nohup sh -c ${shellQuote(command)} >"$bg_log" 2>&1 </dev/null &`,
    "bg_pid=$!",
    `printf '${BACKGROUND_SHELL_MARKER}%s:%s\\n' "$bg_pid" "$bg_log"`,
  ].join("\n")
}

function wrapperBodyForPolicy(policy: DevinShellPolicy): string | undefined {
  if (policy.backgroundSpawn) return buildBackgroundShellCommand(policy.command)
  if (policy.timeoutBehavior === DEVIN_TIMEOUT_BACKGROUND) return buildSoftBackgroundCommand(policy)
  return undefined
}

function writeShellEnvInjector(wrapperBody: string): DevinShellEnvWrap {
  const dir = mkdtempSync(join(tmpdir(), "devin-opencode-wrap-"))
  const wrapperPath = join(dir, "wrapper.sh")
  const bashEnvPath = join(dir, "bashenv.sh")
  const zshenvPath = join(dir, ".zshenv")
  writeFileSync(wrapperPath, `${wrapperBody}\n`, { mode: 0o700 })
  // Sourced by bash (BASH_ENV) or zsh (.zshenv via ZDOTDIR). `exec`
  // replaces the host shell before OpenCode's `-c <original>` body runs.
  const injector = [
    "unset BASH_ENV ZDOTDIR ENV DEVIN_OPENCODE_WRAP_ACTIVE",
    `exec /bin/sh ${shellQuote(wrapperPath)}`,
    "",
  ].join("\n")
  writeFileSync(bashEnvPath, injector, { mode: 0o600 })
  writeFileSync(zshenvPath, injector, { mode: 0o600 })
  return {
    wrapperPath,
    env: {
      BASH_ENV: bashEnvPath,
      ZDOTDIR: dir,
    },
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // best-effort temp cleanup
      }
    },
  }
}

function ensureShellEnvWrap(
  toolCallId: string,
  policy: DevinShellPolicy,
): DevinShellEnvWrap | undefined {
  const existing = activeEnvWraps.get(toolCallId)
  if (existing) return existing
  const wrapperBody = wrapperBodyForPolicy(policy)
  if (!wrapperBody) return undefined
  const wrap = writeShellEnvInjector(wrapperBody)
  remember(activeEnvWraps, toolCallId, wrap, (evicted) => evicted.cleanup())
  return wrap
}

/**
 * Prepare OpenCode Bash args before execution when Devin requested wrapping.
 *
 * bash/zsh source the shell.env injector, so the original command remains in
 * OpenCode's permission/UI state. sh/dash ignore those startup variables; for
 * them, use a short `exec wrapper.sh` command that contains no user payload.
 *
 * background_shell_spawn may already contain the inline non-plugin fallback.
 * The classic hook replaces it with the original command (bash/zsh) or the
 * shorter wrapper-file command (sh/dash), avoiding duplicate execution.
 */
export function prepareDevinShellArgs(
  toolCallId: string,
  args: Record<string, unknown>,
  options: { preferWrapperCommand?: boolean } = {},
): void {
  const policy = policies.get(toolCallId)
  if (!policy) return
  if (!policy.backgroundSpawn && policy.timeoutBehavior !== DEVIN_TIMEOUT_BACKGROUND) return

  pendingEnvWraps.add(toolCallId)
  if (!policy.backgroundSpawn) {
    // The wrapper returns just after Devin's foreground window. OpenCode's own
    // timeout is only an outer safety net and must not win the race.
    args.timeout = Math.max(OPENCODE_TIMEOUT_GRACE_MS, policy.timeoutMs + OPENCODE_TIMEOUT_GRACE_MS)
  }

  const shellKind = resolveDevinShellKind()
  // OpenCode 2.0 has no `shell.env` hook, so bash/zsh cannot be wrapped by
  // sourcing an injector. Callers there opt into the wrapper-file command —
  // the same mechanism sh/dash already use — which needs no env injection.
  const envInjectable =
    !options.preferWrapperCommand && (shellKind === "bash" || shellKind === "zsh")
  if (process.platform === "win32" || envInjectable) {
    // Native Windows PowerShell/cmd wrapping remains unsupported; do not emit
    // a POSIX /bin/sh command there. Git Bash still uses the env path above.
    args.command = policy.command
    return
  }

  const wrap = ensureShellEnvWrap(toolCallId, policy)
  if (wrap) args.command = `exec /bin/sh ${shellQuote(wrap.wrapperPath)}`
}

/** Restore the model-facing command in OpenCode's completed tool title. */
export function devinShellOriginalCommand(toolCallId: string): string | undefined {
  return policies.get(toolCallId)?.command || undefined
}

/** Drop injector temp files for a finished/abandoned Devin shell call. */
export function releaseDevinShellEnv(toolCallId: string): void {
  pendingEnvWraps.delete(toolCallId)
  const active = activeEnvWraps.get(toolCallId)
  if (!active) return
  activeEnvWraps.delete(toolCallId)
  active.cleanup()
}

/**
 * Env vars for OpenCode's shell.env hook. bash/zsh execute the injector; the
 * same materialized wrapper backs the direct-command sh/dash fallback.
 */
export function devinShellEnvForCall(toolCallId: string | undefined): Record<string, string> | undefined {
  if (typeof toolCallId !== "string" || !toolCallId || !pendingEnvWraps.has(toolCallId)) return undefined
  const policy = policies.get(toolCallId)
  if (!policy) return undefined
  const wrap = ensureShellEnvWrap(toolCallId, policy)
  if (!wrap) return undefined
  pendingEnvWraps.delete(toolCallId)
  return wrap.env
}

function withoutMarker(output: string, index: number): string {
  let clean = output.slice(0, index).replace(/[\t ]+$/gm, "").replace(/\n{2,}$/, "\n")
  if (clean.trim() === "" || clean.trim() === "(no output)") clean = ""
  return clean
}

/**
 * OpenCode only stores/renders text (`output` / `metadata.output`). Private
 * markers become typed Devin outcomes, but stripping them alone can leave a
 * blank or partial bash bubble that looks like success. Append a short
 * user-facing status so the UI explains background handoff / timeout.
 */
function formatShellOutcomeDisplay(clean: string, outcome: DevinShellOutcome): string {
  let notice: string | undefined
  if (outcome.kind === "backgrounded") {
    notice = outcome.msToWait > 0
      ? `Still running in the background (pid ${outcome.pid}) after ${outcome.msToWait}ms.`
      : `Started in the background (pid ${outcome.pid}).`
  } else if (outcome.kind === "timeout") {
    notice = `Timed out after ${outcome.timeoutMs}ms.`
  }
  if (!notice) return clean
  if (!clean) return `${notice}\n`
  return clean.endsWith("\n") ? `${clean}${notice}\n` : `${clean}\n${notice}\n`
}

/**
 * Find the last private wrapper sentinel.
 *
 * Soft-background wrappers print the marker as the final intentional line, but
 * the host shell can still append job-control diagnostics afterwards (e.g.
 * "Terminated: 15 … nohup sh -c '…devin-shell-watchdog…'"). Match the sentinel
 * on its own line and discard everything from that point to EOF.
 */
function lastPrivateMarker(
  output: string,
  marker: string,
  valuePattern: string,
): { index: number; values: string[] } | undefined {
  const re = new RegExp(`(?:^|\\r?\\n)(${marker}${valuePattern})`, "g")
  let match: RegExpExecArray | null
  let last: { index: number; values: string[] } | undefined
  while ((match = re.exec(output)) !== null) {
    if (match.index === undefined || match[1] === undefined) continue
    const index = match[0].startsWith("\r\n")
      ? match.index + 2
      : match[0].startsWith("\n")
        ? match.index + 1
        : match.index
    last = { index, values: match.slice(2) }
  }
  return last
}

function parseOpenCodeTimeout(output: string): { output: string; timeoutMs: number } | undefined {
  const closeTag = "</shell_metadata>"
  const closeAt = output.lastIndexOf(closeTag)
  if (closeAt === -1 || output.slice(closeAt + closeTag.length).trim() !== "") return undefined

  const header = /<shell_metadata>\r?\nshell tool terminated command after exceeding timeout (\d+) ms\./
  const match = header.exec(output.slice(0, closeAt))
  if (!match || match.index === undefined) return undefined
  return { output: withoutMarker(output, match.index), timeoutMs: Number(match[1]) }
}

function parseSoftBackgroundOutcome(
  output: string,
  policy: DevinShellPolicy | undefined,
): { output: string; outcome: DevinShellOutcome } | undefined {
  const background = lastPrivateMarker(output, BACKGROUND_MARKER, "(\\d+):([^\\r\\n]+)")
  if (background) {
    const pid = Number(background.values[0])
    if (Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffff_ffff) {
      return {
        output: withoutMarker(output, background.index),
        outcome: {
          kind: "backgrounded",
          shellId: pid,
          pid,
          command: policy?.command ?? "",
          workingDirectory: policy?.workingDirectory ?? "",
          msToWait: policy?.timeoutMs ?? 0,
          reason: 1,
        },
      }
    }
  }
  const timeout = lastPrivateMarker(output, TIMEOUT_MARKER, "(\\d+)")
  if (timeout) {
    return {
      output: withoutMarker(output, timeout.index),
      outcome: { kind: "timeout", timeoutMs: Number(timeout.values[0]) },
    }
  }
  const exit = lastPrivateMarker(output, EXIT_MARKER, "(-?\\d+)")
  if (exit) {
    return {
      output: withoutMarker(output, exit.index),
      outcome: { kind: "exit", code: Number(exit.values[0]) },
    }
  }
  return undefined
}

function parseBackgroundSpawnOutcome(
  output: string,
  policy: DevinShellPolicy | undefined,
): { output: string; outcome: DevinShellOutcome } | undefined {
  const match = lastPrivateMarker(output, BACKGROUND_SHELL_MARKER, "(\\d+):([^\\r\\n]+)")
  if (!match) return undefined
  const pid = Number(match.values[0])
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffff_ffff) return undefined
  return {
    output: withoutMarker(output, match.index),
    outcome: {
      kind: "backgrounded",
      shellId: pid,
      pid,
      command: policy?.command ?? "",
      workingDirectory: policy?.workingDirectory ?? "",
      msToWait: 0,
      reason: 1,
    },
  }
}

/**
 * Strip private wrapper sentinels / OpenCode timeout envelopes for display.
 * Does not record outcomes — use {@link captureDevinShellResult} for that.
 */
export function sanitizeDevinShellDisplayOutput(
  output: string,
  policy?: DevinShellPolicy,
): string {
  if (policy?.backgroundSpawn) {
    const spawn = parseBackgroundSpawnOutcome(output, policy)
    if (spawn) return formatShellOutcomeDisplay(spawn.output, spawn.outcome)
  }
  if (policy?.timeoutBehavior === DEVIN_TIMEOUT_BACKGROUND) {
    const wrapper = parseSoftBackgroundOutcome(output, policy)
    if (wrapper) return formatShellOutcomeDisplay(wrapper.output, wrapper.outcome)
  }
  const timeout = parseOpenCodeTimeout(output)
  if (timeout) {
    return formatShellOutcomeDisplay(timeout.output, {
      kind: "timeout",
      timeoutMs: timeout.timeoutMs,
    })
  }
  return output
}

/** Sanitize a secondary display string (e.g. Bash `metadata.output`) for a registered call. */
export function sanitizeRegisteredDevinShellOutput(toolCallId: string, output: string): string {
  if (typeof toolCallId !== "string" || !toolCallId) return output
  return sanitizeDevinShellDisplayOutput(output, policies.get(toolCallId))
}

/**
 * Capture Bash completion in the classic plugin's after hook. Returns the
 * sanitized output that OpenCode should store and render.
 */
export function captureDevinShellResult(
  toolCallId: string,
  output: string,
  metadata?: Record<string, unknown>,
): string {
  if (typeof toolCallId !== "string" || !toolCallId.startsWith("devin_")) return output
  const policy = policies.get(toolCallId)
  if (policy?.backgroundSpawn) {
    const spawn = parseBackgroundSpawnOutcome(output, policy)
    if (spawn) {
      remember(outcomes, toolCallId, spawn.outcome)
      return formatShellOutcomeDisplay(spawn.output, spawn.outcome)
    }
  }
  // Private wrapper sentinels are meaningful only for calls we transformed.
  // A normal foreground command is allowed to print the same text verbatim.
  const wrapper = policy?.timeoutBehavior === DEVIN_TIMEOUT_BACKGROUND
    ? parseSoftBackgroundOutcome(output, policy)
    : undefined
  if (wrapper) {
    remember(outcomes, toolCallId, wrapper.outcome)
    return formatShellOutcomeDisplay(wrapper.output, wrapper.outcome)
  }
  const timeout = parseOpenCodeTimeout(output)
  if (timeout) {
    const outcome = { kind: "timeout" as const, timeoutMs: timeout.timeoutMs }
    remember(outcomes, toolCallId, outcome)
    return formatShellOutcomeDisplay(timeout.output, outcome)
  }
  const exitCode = finiteNonNegative(metadata?.exit)
  if (exitCode !== undefined) remember(outcomes, toolCallId, { kind: "exit", code: exitCode })
  return output
}

/** Consume the structured result, with an inline fallback when no plugin hook ran. */
export function consumeDevinShellResult(
  toolCallId: string,
  output: string,
): { output: string; outcome?: DevinShellOutcome } {
  if (typeof toolCallId !== "string" || !toolCallId) {
    return { output }
  }
  let clean = output
  if (!outcomes.has(toolCallId)) clean = captureDevinShellResult(toolCallId, output)
  const outcome = outcomes.get(toolCallId)
  outcomes.delete(toolCallId)
  policies.delete(toolCallId)
  releaseDevinShellEnv(toolCallId)
  return { output: clean, outcome }
}

/** Test/process cleanup. */
export function resetDevinShellCalls(): void {
  for (const wrap of activeEnvWraps.values()) wrap.cleanup()
  activeEnvWraps.clear()
  pendingEnvWraps.clear()
  policies.clear()
  outcomes.clear()
  configuredShell = undefined
}