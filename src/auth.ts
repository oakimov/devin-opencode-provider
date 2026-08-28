import * as http from "node:http"
import * as crypto from "node:crypto"
import { withAbortDeadline } from "./deadline.js"
import { WINDSURF_API_HOST, DEVIN_API_HOST, DEVIN_WEBSITE_HOST, WINDSURF_REGISTER_HOST, WINDSURF_OAUTH_CLIENT_ID, WINDSURF_WEBSITE_HOST } from "./shared.js"
import { buildMetadata } from "./protocol/metadata.js"
import { concat, encodeMessage, iterFields } from "./protocol/wire.js"

const API_BASE = `https://${WINDSURF_API_HOST}`
const DEVIN_AUTH_BASE = `https://${DEVIN_API_HOST}`
const DEVIN_APP_BASE = `https://${DEVIN_WEBSITE_HOST}`
const AUTH_TIMEOUT_MS = 15_000

export class AuthExchangeError extends Error {
  constructor(message: string, public cause?: unknown) { super(message); this.name = "AuthExchangeError" }
}
export class AuthRefreshError extends Error {
  constructor(message: string, public cause?: unknown) { super(message); this.name = "AuthRefreshError" }
}

export function isExpiringSoon(jwt: string, thresholdS = 300): boolean {
  const payload = decodeJwtPayload(jwt)
  if (!payload || typeof payload.exp !== "number") return true
  return payload.exp * 1000 - Date.now() < thresholdS * 1000
}

export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const seg = jwt.split(".")[1]
    if (!seg) return null
    const json = Buffer.from(seg, "base64url").toString("utf8")
    const p = JSON.parse(json)
    if (!p || typeof p !== "object" || Array.isArray(p)) return null
    return p as Record<string, unknown>
  } catch { return null }
}

export function decodeJwtExpiryMs(jwt: string): number | null {
  const p = decodeJwtPayload(jwt)
  if (!p || typeof p.exp !== "number" || !Number.isFinite(p.exp)) return null
  return p.exp * 1000
}

// Windsurf uses long-lived api_key (sk-ws-01-xxx, cog_xxx, devin-session-token$xxx)
// and mints short-lived user_jwt via GetUserJwt for each chat. No exchange needed
// for apiKey -> access token like Cursor; but we keep similar resolve interface.

export type TokenPair = { accessToken: string; refreshToken?: string }

export async function mintUserJwt(apiKey: string, host = API_BASE, signal?: AbortSignal): Promise<{ jwt: string; expiresAt: number }> {
  return withAbortDeadline(AUTH_TIMEOUT_MS, () => new AuthExchangeError("GetUserJwt timed out"), async (sig) => {
    const combined = signal ? (AbortSignal as any).any ? (AbortSignal as any).any([signal, sig]) : signal : sig
    const metadata = buildMetadata({ apiKey, sessionId: crypto.randomUUID(), requestId: BigInt(Date.now()), triggerId: crypto.randomUUID() })
    const req = encodeMessage(1, metadata)
    let res: Response
    try {
      res = await fetch(`${host.replace(/\/$/, "")}/exa.auth_pb.AuthService/GetUserJwt`, {
        method: "POST",
        headers: { "Content-Type": "application/proto", "Connect-Protocol-Version": "1" },
        body: req as unknown as BodyInit,
        signal: combined,
      })
    } catch (cause) {
      throw new AuthExchangeError("GetUserJwt network failed", cause)
    }
    const buf = new Uint8Array(await res.arrayBuffer())
    if (!res.ok) throw new AuthExchangeError(`GetUserJwt HTTP ${res.status}: ${new TextDecoder().decode(buf).slice(0, 400)}`)
    let jwt: string | null = null
    for (const f of iterFields(buf)) {
      if (f.num === 1 && f.wire === 2 && f.value instanceof Uint8Array) {
        const s = new TextDecoder().decode(f.value)
        if (/^eyJ[A-Za-z0-9_-]{10,}={0,2}\.[A-Za-z0-9_-]+={0,2}\.[A-Za-z0-9_-]+={0,2}$/.test(s)) { jwt = s; break }
      }
    }
    if (!jwt) throw new AuthExchangeError(`GetUserJwt missing jwt (${buf.length} bytes)`)
    let exp = Math.floor(Date.now() / 1000) + 600
    try {
      const payload = decodeJwtPayload(jwt)
      if (payload && typeof payload.exp === "number") exp = payload.exp
    } catch {}
    return { jwt, expiresAt: exp }
  })
}

let cachedJwt: { jwt: string; expiresAt: number; apiKey: string; host: string } | null = null
let inflight: Map<string, Promise<{ jwt: string; expiresAt: number }>> = new Map()
let epoch = 0

function flightKey(apiKey: string, host: string) { return `${host}\x1f${apiKey}` }

export async function getCachedUserJwt(apiKey: string, host = API_BASE, signal?: AbortSignal): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  if (cachedJwt && cachedJwt.apiKey === apiKey && cachedJwt.host === host && cachedJwt.expiresAt > now + 60) return cachedJwt.jwt
  const key = flightKey(apiKey, host)
  const existing = inflight.get(key)
  if (existing) return (await existing).jwt
  const p = mintUserJwt(apiKey, host, signal)
  inflight.set(key, p)
  const epochAtStart = epoch
  try {
    const minted = await p
    if (epoch === epochAtStart) cachedJwt = { ...minted, apiKey, host }
    return minted.jwt
  } finally { inflight.delete(key) }
}

export function clearCachedUserJwt(): void {
  cachedJwt = null
  inflight.clear()
  epoch++
}

// Resolve bearer: prefer accessToken passthrough, else apiKey is used as devin/windsurf api_key
export async function resolveBearerToken(input: { accessToken?: string; apiKey?: string; baseUrl?: string }): Promise<string> {
  if (input.accessToken) return input.accessToken
  if (!input.apiKey) throw new Error("Devin provider: no access token or API key provided")
  // Windsurf api keys are not exchanged like Cursor's crsr_... ; return as-is for GetUserJwt mint
  // But if it looks like a JWT already, return it
  if (input.apiKey.startsWith("eyJ")) return input.apiKey
  return input.apiKey
}

// ── OAuth PKCE helpers (Windsurf implicit grant) ──
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
async function sha256(data: BufferSource): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data))
}
export type PkceParams = { verifier: string; challenge: string; uuid: string }
export function generatePkceParams(): PkceParams {
  const verifierBytes = new Uint8Array(32)
  crypto.getRandomValues(verifierBytes)
  const verifier = base64url(verifierBytes)
  const uuid = crypto.randomUUID()
  return { verifier, challenge: "", uuid }
}
export async function generatePkceChallenge(verifier: string): Promise<string> {
  const enc = new TextEncoder()
  const hash = await sha256(enc.encode(verifier))
  return base64url(hash)
}
export function buildLoginUrl(challenge: string, uuid: string, websiteUrl = `https://${WINDSURF_WEBSITE_HOST}`): string {
  // Cursor-style deep control (kept for compat); Windsurf uses implicit grant below
  return `${websiteUrl}/loginDeepControl?challenge=${encodeURIComponent(challenge)}&uuid=${encodeURIComponent(uuid)}&mode=login&redirectTarget=cli`
}

// ── Legacy Windsurf OAuth (loopback implicit grant, mirrors rsvedant/opencode-windsurf-auth) ──
// Kept for reference; latest Devin uses PKCE at api.devin.ai (below)

export class AuthPollError extends Error {
  constructor(message: string, public cause?: unknown) { super(message); this.name = "AuthPollError" }
}
export class AuthTimeoutError extends Error {
  constructor(message: string) { super(message); this.name = "AuthTimeoutError" }
}

const WINDSURF_LOGIN_TIMEOUT_MS = 5 * 60 * 1000
const DEVIN_LOGIN_TIMEOUT_MS = 5 * 60 * 1000

export function buildWindsurfLoginUrl(state: string, port: number, websiteUrl = `https://${WINDSURF_WEBSITE_HOST}`): string {
  const redirectUri = `http://127.0.0.1:${port}/auth`
  const params = new URLSearchParams({
    response_type: "token",
    client_id: WINDSURF_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    state,
    prompt: "login",
    redirect_parameters_type: "query",
  })
  return `${websiteUrl}/windsurf/signin?${params.toString()}`
}

// ── Devin OAuth PKCE (app.devin.ai + api.devin.ai) ──
// Verified via prime-agent issue #753 / omp implementation and Devin decompiled workbench
// Authorize: https://app.devin.ai/auth/cli/continue?redirect_uri=...&state=...&prompt=select_account&code_challenge=...&code_challenge_method=S256
// Token: POST https://api.devin.ai/auth/cli/token { code, code_verifier } → { token }

export function buildDevinLoginUrl(opts: { state: string; codeChallenge: string; redirectUri: string; websiteUrl?: string }): string {
  const websiteUrl = opts.websiteUrl ?? DEVIN_APP_BASE
  const params = new URLSearchParams({
    redirect_uri: opts.redirectUri,
    state: opts.state,
    prompt: "select_account",
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
  })
  return `${websiteUrl}/auth/cli/continue?${params.toString()}`
}

export async function exchangeDevinCode(opts: { code: string; codeVerifier: string; apiBaseUrl?: string; signal?: AbortSignal }): Promise<{ token: string }> {
  const base = (opts.apiBaseUrl ?? DEVIN_AUTH_BASE).replace(/\/$/, "")
  const url = `${base}/auth/cli/token`
  const timeoutSignal = AbortSignal.timeout(15_000)
  const combined: AbortSignal | undefined = opts.signal ? (AbortSignal as any).any ? (AbortSignal as any).any([opts.signal, timeoutSignal]) : opts.signal : timeoutSignal
  let res: Response
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: opts.code, code_verifier: opts.codeVerifier }),
      signal: combined,
    })
  } catch (cause) {
    throw new AuthExchangeError("Devin token exchange network failed", cause)
  }
  const text = await res.text()
  if (!res.ok) {
    let msg = text
    try { const j = JSON.parse(text); if (j.message) msg = j.message; if (j.error) msg = `${j.error}: ${msg}` } catch {}
    throw new AuthExchangeError(`Devin token exchange failed ${res.status}: ${msg.slice(0, 500)}`)
  }
  let parsed: any
  try { parsed = JSON.parse(text) } catch { throw new AuthExchangeError(`Devin token exchange non-JSON: ${text.slice(0, 200)}`) }
  const token = parsed.token ?? parsed.access_token ?? parsed.api_key
  if (!token || typeof token !== "string") throw new AuthExchangeError("Devin token exchange missing token")
  return { token }
}

type LoopbackServer = {
  port: number
  close: () => void
  waitForToken: (expectedState: string, signal?: AbortSignal) => Promise<string>
  waitForCode: (expectedState: string, signal?: AbortSignal) => Promise<string>
}

export function createLoopbackServer(preferredPort?: number): Promise<LoopbackServer> {
  return new Promise((resolve, reject) => {
    let capturedToken: { token: string; state: string } | null = null
    let capturedCode: { code: string; state: string } | null = null
    let pendingError: string | null = null
    const tokenWaiters: Array<{ state: string; resolve: (t: string) => void; reject: (e: Error) => void }> = []
    const codeWaiters: Array<{ state: string; resolve: (t: string) => void; reject: (e: Error) => void }> = []

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      // Accept both /auth (Windsurf) and /callback or /auth/callback (Devin)
      const isAuthPath = url.pathname === "/auth" || url.pathname === "/callback" || url.pathname === "/auth/callback"
      if (!isAuthPath) {
        res.writeHead(404, { "Content-Type": "text/plain" })
        res.end("Not Found")
        return
      }
      const token = url.searchParams.get("firebase_id_token") ?? url.searchParams.get("access_token") ?? url.searchParams.get("token") ?? ""
      const code = url.searchParams.get("code") ?? ""
      const state = url.searchParams.get("state") ?? ""
      const error = url.searchParams.get("error") ?? url.searchParams.get("error_description")

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" })
        res.end(`<html><body><h1>Sign-in failed</h1><p>${error}</p></body></html>`)
        pendingError = error
        for (const w of [...tokenWaiters, ...codeWaiters].splice(0)) w.reject(new AuthPollError(error))
        tokenWaiters.length = 0; codeWaiters.length = 0
        return
      }
      // Devin PKCE returns ?code=...&state=...
      if (code) {
        capturedCode = { code, state }
        res.writeHead(200, { "Content-Type": "text/html" })
        res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Devin</title></head><body><h1>Signed in</h1><p>You can close this tab.</p></body></html>`)
        for (let i = codeWaiters.length - 1; i >= 0; i--) {
          const w = codeWaiters[i]
          if (w.state === state) { w.resolve(code); codeWaiters.splice(i, 1) }
        }
        return
      }
      if (!token) {
        // fragment harvester for #access_token case (Windsurf)
        res.writeHead(200, { "Content-Type": "text/html" })
        res.end(`<!doctype html><script>var h=location.hash.replace(/^#/,'');if(h)location.replace('/auth?'+h);else document.body.innerText='No token in URL.';</script>`)
        return
      }
      capturedToken = { token, state }
      res.writeHead(200, { "Content-Type": "text/html" })
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Devin</title></head><body><h1>Signed in</h1><p>You can close this tab.</p></body></html>`)
      for (let i = tokenWaiters.length - 1; i >= 0; i--) {
        const w = tokenWaiters[i]
        if (w.state === state) { w.resolve(token); tokenWaiters.splice(i, 1) }
      }
    })
    server.on("error", reject)
    server.listen(preferredPort ?? 0, "127.0.0.1", () => {
      const addr = server.address()
      if (!addr || typeof addr === "string") { reject(new Error("Failed to bind loopback")); return }
      const makeWaiter = (store: typeof tokenWaiters, captured: { state: string } | null, getCaptured: () => string | null, timeoutMs: number) =>
        (expectedState: string, signal?: AbortSignal) =>
          new Promise<string>((res, rej) => {
            if (pendingError) { rej(new AuthPollError(pendingError)); return }
            const cap = getCaptured()
            if (cap && captured && (captured as any).state === expectedState) { res(cap); return }
            if (signal?.aborted) { rej(new AuthTimeoutError("Poll cancelled")); return }
            const waiter = { state: expectedState, resolve: res, reject: rej }
            store.push(waiter)
            const onAbort = () => {
              const idx = store.indexOf(waiter)
              if (idx >= 0) store.splice(idx, 1)
              rej(new AuthTimeoutError("Poll cancelled"))
            }
            signal?.addEventListener("abort", onAbort, { once: true })
            const timer = setTimeout(() => {
              const idx = store.indexOf(waiter)
              if (idx >= 0) store.splice(idx, 1)
              rej(new AuthTimeoutError("Sign-in timed out — complete browser flow within 5 minutes"))
            }, timeoutMs)
            // @ts-ignore
            timer.unref?.()
          })
      resolve({
        port: (addr as any).port,
        close: () => server.close(),
        waitForToken: makeWaiter(tokenWaiters, capturedToken, () => capturedToken?.token ?? null, WINDSURF_LOGIN_TIMEOUT_MS),
        waitForCode: makeWaiter(codeWaiters, capturedCode, () => capturedCode?.code ?? null, DEVIN_LOGIN_TIMEOUT_MS),
      })
    })
  })
}

export type WindsurfRegistrationResult = { apiKey: string; name: string; apiServerUrl: string }

export async function registerWindsurfUser(firebaseToken: string, signal?: AbortSignal): Promise<WindsurfRegistrationResult> {
  const url = `https://${WINDSURF_REGISTER_HOST}/exa.seat_management_pb.SeatManagementService/RegisterUser`
  const timeoutSignal = AbortSignal.timeout(30_000)
  const combined: AbortSignal = signal ? (AbortSignal as any).any ? (AbortSignal as any).any([signal, timeoutSignal]) : signal : timeoutSignal
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
    body: JSON.stringify({ firebase_id_token: firebaseToken }),
    signal: combined,
  })
  const text = await res.text()
  if (!res.ok) {
    let code: string | undefined
    let msg = text
    try { const j = JSON.parse(text); code = j.code; if (j.message) msg = j.message } catch {}
    throw new AuthExchangeError(`RegisterUser failed ${res.status} ${code ?? ""}: ${msg.slice(0, 400)}`)
  }
  let parsed: any
  try { parsed = JSON.parse(text) } catch { throw new AuthExchangeError(`RegisterUser non-JSON: ${text.slice(0, 200)}`) }
  if (!parsed.api_key || !parsed.name) throw new AuthExchangeError("RegisterUser missing api_key/name")
  return { apiKey: parsed.api_key, name: parsed.name, apiServerUrl: parsed.api_server_url || `https://${WINDSURF_API_HOST}` }
}

export async function pollForWindsurfTokens(state: string, server: LoopbackServer, signal?: AbortSignal): Promise<WindsurfRegistrationResult> {
  const token = await server.waitForToken(state, signal)
  return registerWindsurfUser(token, signal)
}

export async function pollForDevinTokens(opts: { state: string; server: LoopbackServer; codeVerifier: string; apiBaseUrl?: string; signal?: AbortSignal }): Promise<{ token: string }> {
  const code = await opts.server.waitForCode(opts.state, opts.signal)
  const { token } = await exchangeDevinCode({ code, codeVerifier: opts.codeVerifier, apiBaseUrl: opts.apiBaseUrl, signal: opts.signal })
  // Normalize to devin-session-token$<jwt> if needed; api.devin.ai returns a JWT
  if (token.startsWith("devin-session-token$") || token.startsWith("cog_") || token.startsWith("sk-")) return { token }
  // If raw JWT, prefix as session token for consistency with omp
  if (token.startsWith("eyJ")) return { token: `devin-session-token$${token}` }
  return { token }
}
