export async function withAbortDeadline<T>(
  timeoutMs: number,
  makeError: () => Error,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(makeError()), timeoutMs)
  // @ts-ignore unref
  timer.unref?.()
  try {
    return await run(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}
