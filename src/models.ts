import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { MODEL_CACHE_FILE, MODEL_CACHE_SCHEMA_VERSION, MODEL_CACHE_TTL_MS } from "./shared.js"
import { buildMetadata } from "./protocol/metadata.js"
import { concat, encodeMessage, iterFields } from "./protocol/wire.js"
import { getCachedUserJwt } from "./auth.js"
import { trace } from "./debug.js"

export type ModelInfo = {
  id: string
  displayName?: string
  family?: string
  maxContext?: number
  maxOutput?: number
}

export type ModelCache = {
  models: ModelInfo[]
  fetchedAt: number
  schemaVersion?: number
}

export function cacheFilePath(cacheDir: string): string {
  return path.join(cacheDir, MODEL_CACHE_FILE)
}

export async function readCache(cacheDir: string): Promise<ModelCache | null> {
  try {
    const raw = await readFile(cacheFilePath(cacheDir), "utf8")
    const parsed = JSON.parse(raw) as ModelCache
    if (!parsed || !Array.isArray(parsed.models)) return null
    return parsed
  } catch { return null }
}

export function isCacheFresh(cache: ModelCache): boolean {
  if (cache.schemaVersion !== MODEL_CACHE_SCHEMA_VERSION) return false
  return Date.now() - cache.fetchedAt < MODEL_CACHE_TTL_MS
}

async function writeCache(cacheDir: string, models: ModelInfo[]): Promise<void> {
  await mkdir(cacheDir, { recursive: true })
  const cache: ModelCache = { models, fetchedAt: Date.now(), schemaVersion: MODEL_CACHE_SCHEMA_VERSION }
  await writeFile(cacheFilePath(cacheDir), JSON.stringify(cache, null, 2))
}

/**
 * Fetch live model list — latest endpoints via Devin 3.7.25 decompiled:
 *   Primary: GetCascadeModelConfigs at server.codeium.com (ClientModelConfig#22 model_uid, #1 label, #4 disabled)
 *   Fallback: GetUserStatus seat_management (cascade_model_config_data)
 * Mirrors rsvedant catalog + devin_mock proto_util.
 */
export async function discoverModels(accessToken: string, cacheDir: string, opts: { baseURL?: string; signal?: AbortSignal } = {}): Promise<ModelInfo[]> {
  // Real Devin API — per decompiled 3.7.25 and DEVIN_MOCK_SERVER.md, models live at server.codeium.com
  // Mock is only reference for protocol; never contact 127.0.0.1:50001 in production.
  const base = (opts.baseURL ?? process.env.DEVIN_API_BASE_URL ?? process.env.WINDSURF_API_BASE_URL ?? "https://server.codeium.com").replace(/\/$/, "")
  let userJwt: string | undefined
  try { userJwt = await getCachedUserJwt(accessToken, base, opts.signal) } catch {}
  const metadata = buildMetadata({ apiKey: accessToken, userJwt, sessionId: crypto.randomUUID(), requestId: BigInt(Date.now()), triggerId: crypto.randomUUID() })
  const req = encodeMessage(1, metadata)
  const headers: Record<string, string> = {
    "Content-Type": "application/proto",
    "Connect-Protocol-Version": "1",
    Authorization: `Bearer ${accessToken}`,
  }
  const tryFetch = async (path: string): Promise<Uint8Array | null> => {
    const url = `${base}/${path}`
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: req as unknown as BodyInit,
        signal: opts.signal,
      })
      if (!res.ok) {
        trace(`${path} HTTP ${res.status}`)
        return null
      }
      return new Uint8Array(await res.arrayBuffer())
    } catch (e) {
      trace(`${path} failed: ${(e as Error).message}`)
      return null
    }
  }
  const candidates: Array<{ path: string; parser: (b: Uint8Array) => ModelInfo[] }> = [
    { path: "exa.api_server_pb.ApiServerService/GetCascadeModelConfigs", parser: parseCascadeModelConfigs },
    { path: "exa.api_server_pb.ApiServerService/GetCliModelConfigs", parser: parseCascadeModelConfigs },
    { path: "exa.seat_management_pb.SeatManagementService/GetUserStatus", parser: parseModelsFromUserStatus },
    { path: "exa.api_server_pb.ApiServerService/GetUserStatus", parser: parseModelsFromUserStatus },
  ]
  let best: ModelInfo[] = []
  for (const c of candidates) {
    const buf = await tryFetch(c.path)
    if (!buf || buf.length < 10) continue
    const models = c.parser(buf)
    trace(`${c.path} -> ${models.length} models`)
    if (models.length > best.length) best = models
    if (models.some(m => /swe/i.test(m.id))) break
  }
  const models = best
  if (models.length) await writeCache(cacheDir, models).catch(() => {})
  trace(`discoverModels: final ${models.length} models`)
  return models
}

function parseCascadeModelConfigs(buf: Uint8Array): ModelInfo[] {
  const models: ModelInfo[] = []
  const seen = new Set<string>()
  for (const f of iterFields(buf)) {
    if (f.num !== 1 || f.wire !== 2 || !(f.value instanceof Uint8Array)) continue
    let label = ""
    let modelUid = ""
    let disabled = false
    for (const sf of iterFields(f.value)) {
      if (sf.num === 1 && sf.wire === 2 && sf.value instanceof Uint8Array) label = new TextDecoder().decode(sf.value).trim()
      else if (sf.num === 4 && sf.wire === 0) disabled = sf.value === 1n || sf.value === 1
      else if (sf.num === 22 && sf.wire === 2 && sf.value instanceof Uint8Array) modelUid = new TextDecoder().decode(sf.value).trim()
    }
    if (modelUid && !seen.has(modelUid)) {
      if (disabled) {
        trace(`skip disabled ${modelUid}`)
        continue
      }
      seen.add(modelUid)
      models.push({ id: modelUid, displayName: label || modelUid })
    }
  }
  return models
}

function parseModelsFromUserStatus(buf: Uint8Array): ModelInfo[] {
  const models: ModelInfo[] = []
  // Response shape: GetUserStatusResponse { #1 user_status, #2 plan_info }
  // user_status at #1 contains #33 cascade_model_config_data → client_model_configs
  const seen = new Set<string>()
  const scan = (b: Uint8Array, depth = 0): void => {
    if (depth > 6) return
    for (const f of iterFields(b)) {
      if (f.wire === 2 && f.value instanceof Uint8Array) {
        const bytes = f.value
        // Use cascade parser on any blob that looks like repeated field 1
        const sub = parseCascadeModelConfigs(bytes)
        for (const m of sub) if (!seen.has(m.id)) { seen.add(m.id); models.push(m) }
        // Fallback brute for GetUserStatus nested encoding — respect disabled
        for (const inner of iterFields(bytes)) {
          if (inner.num === 22 && inner.wire === 2 && inner.value instanceof Uint8Array) {
            const uid = new TextDecoder().decode(inner.value).trim()
            if (uid && !seen.has(uid) && /^[a-z0-9._\-]+$/i.test(uid) && uid.length >= 3 && uid.length <= 128) {
              let disabled = false
              for (const sf of iterFields(bytes)) if (sf.num === 4 && sf.wire === 0) disabled = sf.value === 1n
              if (disabled) {
                trace(`skip disabled ${uid} (brute)`)
                continue
              }
              seen.add(uid)
              let label: string | undefined
              for (const lf of iterFields(bytes)) {
                if (lf.num === 1 && lf.wire === 2 && lf.value instanceof Uint8Array) {
                  label = new TextDecoder().decode(lf.value).trim()
                  break
                }
              }
              models.push({ id: uid, displayName: label || uid })
            }
          }
        }
        scan(bytes, depth + 1)
      }
    }
  }
  scan(buf)
  return models
}
