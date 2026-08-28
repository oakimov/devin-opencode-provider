export class DevinProviderError extends Error {
  public code?: string
  public transient?: boolean
  public replaySafe?: boolean
  public retryAfterMs?: number
  public cause?: unknown
  constructor(message: string, opts: { code?: string; transient?: boolean; replaySafe?: boolean; retryAfterMs?: number; cause?: unknown } = {}) {
    super(message)
    this.name = "DevinProviderError"
    this.code = opts.code
    this.transient = opts.transient
    this.replaySafe = opts.replaySafe
    this.retryAfterMs = opts.retryAfterMs
    this.cause = opts.cause
  }
}

export class DevinAuthError extends DevinProviderError {
  constructor(message: string, opts: { code?: string; cause?: unknown } = {}) {
    super(message, { ...opts, transient: false })
    this.name = "DevinAuthError"
  }
}

export class DevinTransportError extends DevinProviderError {
  constructor(message: string, opts: { transient?: boolean; replaySafe?: boolean; code?: string; cause?: unknown } = {}) {
    super(message, opts)
    this.name = "DevinTransportError"
  }
}

export class DevinProtocolError extends DevinProviderError {
  constructor(message: string, opts: { code?: string; cause?: unknown } = {}) {
    super(message, opts)
    this.name = "DevinProtocolError"
  }
}

export function toDevinProviderError(error: unknown, fallback: string | { message: string; replaySafe?: boolean } = "Devin provider error"): DevinProviderError {
  if (error instanceof DevinProviderError) return error
  const message = typeof fallback === "string" ? fallback : fallback.message
  return new DevinProviderError(`${message}: ${error instanceof Error ? error.message : String(error)}`, {
    cause: error,
    replaySafe: typeof fallback === "object" ? fallback.replaySafe : undefined,
  })
}

export function isTransientGrpcStatus(code: string): boolean {
  return ["unavailable", "resource_exhausted", "deadline_exceeded", "aborted"].includes(code)
}

export function devinGrpcError(prefix: string, code: string): DevinProviderError {
  const transient = isTransientGrpcStatus(code)
  if (code === "unauthenticated" || code === "permission_denied") {
    return new DevinAuthError(`${prefix} ${code}`)
  }
  return new DevinProviderError(`${prefix} ${code}`, { code, transient, replaySafe: true })
}

export function devinHttpError(prefix: string, status: number): DevinProviderError {
  if (status === 401 || status === 403) return new DevinAuthError(`${prefix} HTTP ${status}`)
  const transient = status === 429 || status >= 500
  return new DevinProviderError(`${prefix} HTTP ${status}`, { code: String(status), transient, replaySafe: true })
}

export function errorCode(cause: unknown): string | undefined {
  if (cause && typeof cause === "object" && "code" in cause) {
    const c = (cause as Record<string, unknown>).code
    if (typeof c === "string") return c
  }
  return undefined
}
