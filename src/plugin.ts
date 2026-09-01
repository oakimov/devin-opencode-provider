import type { Hooks, PluginInput, Config } from "@opencode-ai/plugin"
import type { Auth } from "@opencode-ai/sdk"
import { DEVIN_PROVIDER_ID, WINDSURF_PROVIDER_ID, DEVIN_WEBSITE_HOST, DEVIN_API_HOST } from "./shared.js"
import { devinApiBaseURL } from "./plugin-core.js"
import { readCache, discoverModels, isCacheFresh } from "./models.js"
import { modelsToConfig } from "./model-config.js"
import { opencodeGlobalCacheDir } from "./context/paths.js"
import { readStoredAuth, type StoredAuth } from "./context/auth-store.js"
import { getCachedUserJwt, createLoopbackServer, buildDevinLoginUrl, generatePkceParams, generatePkceChallenge, pollForDevinTokens, isExpiringSoon, decodeJwtExpiryMs } from "./auth.js"
import { trace } from "./debug.js"

const MODULE_URL = new URL("./index.js", import.meta.url).href

export async function DevinPlugin(input: PluginInput): Promise<Hooks> {
  const cacheDir = opencodeGlobalCacheDir()
  const apiBaseURL = devinApiBaseURL()

  let sessionAccessToken: string | undefined

  async function persistAuth(body: Auth): Promise<void> {
    await input.client.auth.set({ path: { id: DEVIN_PROVIDER_ID }, body })
  }
  async function persistAuthBestEffort(body: Auth): Promise<void> {
    try { await persistAuth(body) } catch (e) {
      const err = e as Error
      trace(`persistAuthBestEffort: failed to persist auth: ${err.message}`)
    }
  }
  async function authFromStore(): Promise<Auth | StoredAuth | undefined> {
    return readStoredAuth(DEVIN_PROVIDER_ID)
  }
  async function authForLoader(getAuth: () => Promise<Auth | undefined>): Promise<Auth | StoredAuth | undefined> {
    return (await getAuth()) ?? (await authFromStore())
  }
  async function resolveAccessToken(auth: Auth | StoredAuth): Promise<string | undefined> {
    if (auth.type === "api") {
      // devin-session-token$<jwt> — check expiry but no refresh endpoint; just warn
      const raw = auth.key
      const jwt = raw.includes("$") ? raw.split("$").pop()! : raw
      if (jwt && isExpiringSoon(jwt)) {
        // no refresh; return stale and let next login refresh
      }
      if (raw) sessionAccessToken = raw
      return raw
    }
    if (auth.type === "oauth") {
      // oauth may store as access (devin PKCE returns key) or classic access/refresh
      const maybeKey = (auth as any).key as string | undefined
      if (maybeKey) {
        if (maybeKey) sessionAccessToken = maybeKey
        return maybeKey
      }
      if (!isExpiringSoon(auth.access)) {
        sessionAccessToken = auth.access
        return auth.access
      }
      // No refresh for devin PKCE (single token); return stale
      if (auth.access) sessionAccessToken = auth.access
      return auth.access
    }
    return undefined
  }

  async function loadModels(): Promise<Record<string, any>> {
    const cached = await readCache(cacheDir)
    const auth = await authFromStore()
    if (!auth) return cached?.models.length ? modelsToConfig(cached.models) : {}
    const accessToken = await resolveAccessToken(auth)
    if (!accessToken) return cached?.models.length ? modelsToConfig(cached.models) : {}
    try {
      // discoverModels handles stale-while-revalidate: fresh → serve cached + background refresh,
      // stale → try refresh with fallback to stale, no cache → must fetch.
      const models = await discoverModels(accessToken, cacheDir, { baseURL: apiBaseURL })
      return modelsToConfig(models)
    } catch (e) {
      const err = e as Error
      trace(`loadModels: discovery failed, falling back to cache: ${err.message}`)
      console.error(`[devin-provider] Model discovery failed: ${err.message}`)
      return cached?.models.length ? modelsToConfig(cached.models) : {}
    }
  }

  return {
    async config(cfg: Config) {
      cfg.provider ??= {}
      const models = await loadModels()
      for (const pid of [DEVIN_PROVIDER_ID, WINDSURF_PROVIDER_ID]) {
        const existing = (cfg.provider as Record<string, unknown>)[pid] as
          | { models?: Record<string, unknown>; name?: string; npm?: string }
          | undefined
        if (existing) {
          // Always refresh — otherwise a stale first load keeps old flat/unsorted variants.
          ;(existing as { models: Record<string, unknown> }).models = models
          continue
        }
        // Only install primary on first run; keep windsurf alias minimal
        if (pid === DEVIN_PROVIDER_ID) {
          ;(cfg.provider as Record<string, unknown>)[pid] = {
            name: "Devin (Windsurf)",
            npm: MODULE_URL,
            models,
          }
        }
      }
    },

    auth: {
      provider: DEVIN_PROVIDER_ID,
      // Alias so opencode auth login shows both ids
      // (OpenCode resolves provider list from config; alias handled above)
      methods: [
        {
          type: "oauth",
          label: "Devin account (browser login) — PKCE via api.devin.ai",
          async authorize(): Promise<import("@opencode-ai/plugin").AuthOAuthResult> {
            const pkce = generatePkceParams()
            const challenge = await generatePkceChallenge(pkce.verifier)
            const state = pkce.uuid
            const server = await createLoopbackServer()
            const redirectUri = `http://127.0.0.1:${server.port}/callback`
            const websiteUrl = process.env.DEVIN_WEBSITE_URL ?? `https://${DEVIN_WEBSITE_HOST}`
            const apiBaseUrl = process.env.DEVIN_API_BASE_URL ?? `https://${DEVIN_API_HOST}`
            const url = buildDevinLoginUrl({ state, codeChallenge: challenge, redirectUri, websiteUrl })

            return {
              url,
              instructions: "Open this URL in a browser to sign in to Devin (api.devin.ai)",
              method: "auto",
              async callback() {
                try {
                  const { token } = await pollForDevinTokens({ state, server, codeVerifier: pkce.verifier, apiBaseUrl })
                  // Validate token by minting GetUserJwt against server.codeium.com
                  await getCachedUserJwt(token, apiBaseURL).catch((e) => {
                    trace(`auth callback: GetUserJwt validation failed: ${(e as Error).message}`)
                  })
                  // Warm model cache
                  await discoverModels(token, cacheDir, { baseURL: apiBaseURL }).catch((e) => {
                    trace(`auth callback: model cache warm failed: ${(e as Error).message}`)
                  })
                  const jwt = token.includes("$") ? (token.split("$").pop() ?? token) : token
                  return {
                    type: "success" as const,
                    provider: DEVIN_PROVIDER_ID,
                    access: token,
                    refresh: "",
                    expires: decodeJwtExpiryMs(jwt) ?? Date.now() + 3_600_000,
                  }
                } finally {
                  server.close()
                }
              },
            }
          },
        },
        {
          type: "api",
          label: "API key (Windsurf / Devin)",
          prompts: [
            {
              type: "text",
              key: "apiKey",
              message: "Windsurf API key (sk-ws-01-..., cog_..., or devin-session-token$...)",
              placeholder: "sk-ws-01-...",
              validate(value: string) {
                if (!value.trim()) return "API key is required"
                return undefined
              },
            },
          ],
          async authorize(inputs) {
            const apiKey = (inputs as Record<string, string> | undefined)?.apiKey
            if (!apiKey) return { type: "failed" }
            // Validate by minting a user_jwt
            try {
              await getCachedUserJwt(apiKey, apiBaseURL)
              return { type: "success", key: apiKey, provider: DEVIN_PROVIDER_ID }
            } catch {
              return { type: "failed" }
            }
          },
        },
      ],
      async loader(getAuth) {
        const auth = await authForLoader(getAuth as () => Promise<Auth | undefined>)
        const accessToken = (auth ? await resolveAccessToken(auth) : undefined) ?? sessionAccessToken ?? (process.env.DEVIN_API_KEY ?? process.env.WINDSURF_API_KEY)
        if (accessToken) {
          // Use stale-while-revalidate with deduplication; fresh cache returns immediately
          // and refreshes in background, so this does not block auth.
          await discoverModels(accessToken, cacheDir, { baseURL: apiBaseURL }).catch((e) => {
            trace(`auth loader: model discovery failed: ${(e as Error).message}`)
          })
          await getCachedUserJwt(accessToken, apiBaseURL).catch((e) => {
            trace(`auth loader: GetUserJwt failed: ${(e as Error).message}`)
          })
          return { accessToken, workspaceRoot: input.directory, cacheDir }
        }
        return { workspaceRoot: input.directory, cacheDir }
      },
    },
  }
}

// Back-compat aliases moved to devin-opencode-provider/compat subpath
// so the package root stays plugin-safe and pi-bridge auto-detect works
// with a single `DevinPlugin` export (like cursor's single `CursorPlugin`).
