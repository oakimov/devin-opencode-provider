import path from "node:path"
import { pathToFileURL } from "node:url"
import type { Hooks, PluginInput, AuthOAuthResult, Config, ToolDefinition } from "@opencode-ai/plugin"
import type { Auth } from "@opencode-ai/sdk"
import {
  DEVIN_PROVIDER_ID,
  WINDSURF_PROVIDER_ID,
  DEVIN_WEBSITE_HOST,
  DEVIN_API_HOST,
  DEVIN_COMPACTION_OPTION,
  DEVIN_HOST_AGENT_OPTION,
} from "./shared.js"
import { devinApiBaseURL } from "./plugin-core.js"
import { readCache, discoverModels } from "./models.js"
import { modelsToConfig } from "./model-config.js"
export { modelInfoToConfig, modelsToConfig, thinkingSuffixBaseNames } from "./model-config.js"
import { opencodeGlobalCacheDir, opencodeGlobalConfigDirs } from "./context/paths.js"
import { readStoredAuth, type StoredAuth } from "./context/auth-store.js"
import { getCachedUserJwt, createLoopbackServer, buildDevinLoginUrl, generatePkceParams, generatePkceChallenge, pollForDevinTokens, isExpiringSoon, decodeJwtExpiryMs } from "./auth.js"
import { trace } from "./debug.js"
import {
  captureDevinShellResult,
  devinShellEnvForCall,
  devinShellOriginalCommand,
  prepareDevinShellArgs,
  releaseDevinShellEnv,
  sanitizeRegisteredDevinShellOutput,
  setDevinShellPath,
} from "./shell-timeout.js"
import { createOpenCodeWebSearchTool, classicToolFactoryFromModule, openCodeWebSearchTool } from "./web-search-tool.js"

const MODULE_URL = new URL("./index.js", import.meta.url).href

export async function loadClassicTools(options: {
  importModule?: (specifier: string) => Promise<unknown>
  configDirs?: string[]
} = {}): Promise<{ webSearch: Record<string, unknown> }> {
  const configDir = options.configDirs?.[0] ?? opencodeGlobalConfigDirs()[0]
  const candidates = [
    ...(configDir
      ? [path.join(configDir, "node_modules", "@opencode-ai", "plugin", "dist", "index.js")]
      : []),
    "@opencode-ai/plugin",
  ]
  const importModule = options.importModule ?? ((specifier: string) => import(specifier))
  for (const candidate of candidates) {
    try {
      const specifier = path.win32.isAbsolute(candidate) && !path.isAbsolute(candidate)
        ? new URL(`file:///${candidate.replaceAll("\\", "/")}`).href
        : path.isAbsolute(candidate)
          ? pathToFileURL(candidate).href
          : candidate
      const module = await importModule(specifier)
      const factory = classicToolFactoryFromModule(module)
      if (!factory) continue
      return { webSearch: createOpenCodeWebSearchTool(factory) }
    } catch {
      // Try the next host-owned/normal resolution location.
    }
  }
  return { webSearch: openCodeWebSearchTool }
}

export async function DevinPlugin(input: PluginInput): Promise<Hooks> {
  const cacheDir = opencodeGlobalCacheDir()
  const apiBaseURL = devinApiBaseURL()
  const classicTools = await loadClassicTools()

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
    tool: {
      // `websearch` is a reserved OpenCode id and is filtered for third-party
      // providers after plugin tools are merged. Use the collision-safe id
      // so this host-side fallback survives that filter. OpenCode 2.0 does
      // not advertise this fallback: public ToolContext cannot request
      // permission, so that entrypoint uses `ctx.websearch.transform`.
      custom_websearch: classicTools.webSearch as ToolDefinition,
    },

    async "tool.execute.before"(
      hookInput: { tool: string; callID: string },
      output: { args: Record<string, unknown> },
    ) {
      if (hookInput.tool !== "bash" && hookInput.tool !== "shell") return
      if (!output?.args || typeof output.args !== "object" || Array.isArray(output.args) || !Object.isExtensible(output.args)) return
      prepareDevinShellArgs(hookInput.callID, output.args)
    },

    async "shell.env"(
      hookInput: { cwd: string; sessionID?: string; callID?: string },
      output: { env: Record<string, string> },
    ) {
      const env = devinShellEnvForCall(hookInput.callID)
      if (!env || !output || typeof output !== "object" || !Object.isExtensible(output)) return
      if (!output.env || typeof output.env !== "object" || !Object.isExtensible(output.env)) {
        output.env = { ...env }
        return
      }
      Object.assign(output.env, env)
    },

    async "tool.execute.after"(
      hookInput: { tool: string; callID: string },
      output: { title?: string; output: string; metadata?: Record<string, unknown> },
    ) {
      if (hookInput.tool !== "bash" && hookInput.tool !== "shell") return
      try {
        if (!output || typeof output !== "object" || !Object.isExtensible(output)) return
        if (typeof output.title === "string" || output.title === undefined) {
          output.title = devinShellOriginalCommand(hookInput.callID) ?? output.title
        }
        if (typeof output.output === "string") {
          output.output = captureDevinShellResult(
            hookInput.callID,
            output.output,
            output.metadata && typeof output.metadata === "object" ? output.metadata : undefined,
          )
        }
        if (output.metadata && typeof output.metadata === "object" && Object.isExtensible(output.metadata)) {
          const metadata = output.metadata as Record<string, unknown>
          if (typeof metadata.output === "string") {
            metadata.output = sanitizeRegisteredDevinShellOutput(hookInput.callID, metadata.output)
          }
        }
      } finally {
        releaseDevinShellEnv(hookInput.callID)
      }
    },

    async "chat.params"(
      hookInput: { model: { providerID: string }; agent: string },
      output: { options: Record<string, unknown> },
    ) {
      if (hookInput.model.providerID !== DEVIN_PROVIDER_ID && hookInput.model.providerID !== WINDSURF_PROVIDER_ID) return
      if (!output || typeof output !== "object") return
      if (output.options === undefined) {
        if (!Object.isExtensible(output)) return
        output.options = {}
      }
      if (!output.options || typeof output.options !== "object" || Array.isArray(output.options) || !Object.isExtensible(output.options)) return
      output.options[DEVIN_HOST_AGENT_OPTION] = hookInput.agent
      if (hookInput.agent === "compaction") {
        output.options[DEVIN_COMPACTION_OPTION] = true
      }
    },

    async config(cfg: Config) {
      setDevinShellPath((cfg as Config & { shell?: string }).shell)
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
          async authorize(): Promise<AuthOAuthResult> {
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
          async authorize(inputs: Record<string, string> | undefined) {
            const apiKey = inputs?.apiKey
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
      async loader(getAuth: () => Promise<Auth | undefined>) {
        const auth = await authForLoader(getAuth)
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
