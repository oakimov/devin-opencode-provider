const enabled = process.env.DEVIN_PROVIDER_DEBUG === "1" || process.env.DEVIN_PROVIDER_DEBUG === "true"

export function trace(msg: string): void {
  if (!enabled) return
  const line = `[devin-provider] ${new Date().toISOString()} ${msg}\n`
  try {
    process.stderr.write(line)
  } catch {
    // ignore
  }
}
