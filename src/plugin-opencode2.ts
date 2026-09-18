import {
  DEVIN_PROVIDER_ID,
  DEVIN_COMPACTION_OPTION,
  DEVIN_HOST_AGENT_OPTION,
} from "./shared.js"
import { createSdk, devinApiBaseURL, isDevinPackage } from "./plugin-core.js"
import { opencodeGlobalCacheDir } from "./context/paths.js"
import { discoverModels, isCacheFresh, readCache, type ModelInfo } from "./models.js"
import {
  fetchOpenCodeWebSearchText,
  parseExaWebSearchResults,
} from "./web-tools.js"
import {
  captureDevinShellResult,
  clearDevinShellTracking,
  devinShellEnvForCommand,
  prepareDevinShellArgs,
  releaseDevinShellEnv,
  sanitizeRegisteredDevinShellOutput,
} from "./shell-timeout.js"
import { applyDevinProviderInventory, DEVIN_INTEGRATION_ID } from "./opencode2/catalog.js"
import { applyDevinIntegration, resolveDevinAccessToken } from "./opencode2/integration.js"
import { registerTodoTools } from "./opencode2/todo-tools.js"
import { clearSessionTodos, clearAllSessionTodos } from "./todo-store.js"
import { clearCompactionSessions, markCompactionSession } from "./compaction-marker.js"
import { clearSessionDirectories, clearSessionDirectory, markSessionDirectory } from "./session-directory.js"
import { DevinPlugin } from "./plugin.js"
import type { CreateDevinOptions } from "./index.js"
import type {
  Cleanup,
  ConnectionInfo,
  PluginContext,
  Plugin2,
} from "./opencode2/types.js"

/**
 * OpenCode 2.0 plugin.
 *
 * Separate from `plugin-v2.ts` on purpose: the OpenCode 1.18 `/v2/promise` API
 * and the 2.0 API are source-incompatible (hook signatures, OAuth value type,
 * provider schema), so they cannot share an entrypoint. Shared behavior lives in
 * `plugin-core.ts`, `model-config.ts`, and `opencode2/*`.
 *
 * Models register in memory via `ctx.provider.transform` + `editor.remove`
 * (when the host has it) + `editor.add` + `reload()`. Nothing is written
 * into `opencode.json`.
 *
 * Dual export: `{ id, setup, server: DevinPlugin }`. OpenCode 2.0 Host.resolve
 * loads `./server` then `setup()`. OpenCode 1.18 also prefers `exports["./server"]`
 * and then calls `server()` so classic 1.x hooks still run.
 *
 * Load with:  { "plugin": ["devin-opencode-provider/plugin/opencode2"] }
 * or a local package directory under `$OPENCODE_CONFIG_DIR/plugins/` that
 * re-exports `dist/plugin-opencode2.js` (OpenCode 2.0 requires a directory,
 * not a .js path).
 */

async function loadModels(
  cacheDir: string,
  accessToken: string | undefined,
  forceRefresh = false,
): Promise<ModelInfo[]> {
  const cached = await readCache(cacheDir)
  if (!forceRefresh && cached?.models.length && isCacheFresh(cached)) return cached.models

  if (accessToken) {
    try {
      return await discoverModels(accessToken, cacheDir, {
        baseURL: devinApiBaseURL(),
        forceRefresh,
      })
    } catch {
      // A forced refresh follows a credential switch. Do not bind a cache
      // produced by the prior account to the new connection on failure.
      if (forceRefresh) return []
    }
  }
  if (forceRefresh) return []
  // Preserve offline / stale-cache behavior rather than emptying the picker.
  return cached?.models ?? []
}

function toolExecutionID(event: { readonly id?: string; readonly callID?: string }): string {
  const id = event.id ?? event.callID
  if (!id) throw new Error("OpenCode 2.0 tool hook did not provide an execution id")
  return id
}

function isShellTool(name: string | undefined): boolean {
  return name === "bash" || name === "shell"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function isExtensibleRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.isExtensible(value)
}

function eventPayload(event: unknown): Record<string, unknown> {
  if (!isRecord(event)) return {}
  if (isRecord(event.data)) return event.data
  if (isRecord(event.properties)) return event.properties
  return event
}

function writeSessionOption(
  event: { options?: Record<string, unknown> },
  key: string,
  value: unknown,
): void {
  if (!isRecord(event)) return
  if (event.options === undefined) {
    if (!Object.isExtensible(event)) return
    event.options = { [key]: value }
    return
  }
  if (!isExtensibleRecord(event.options)) return
  event.options[key] = value
}

function languageModelFromSdk(sdk: unknown): ((modelId: string) => unknown) | undefined {
  if (!isRecord(sdk) || typeof sdk.languageModel !== "function") return undefined
  return sdk.languageModel as (modelId: string) => unknown
}

function applyCompletedShellResult(executionID: string, result: unknown): void {
  if (!isExtensibleRecord(result)) return
  const metadata = isRecord(result.metadata) ? result.metadata : undefined
  if (typeof result.output === "string") {
    result.output = captureDevinShellResult(executionID, result.output, metadata)
  } else if (isExtensibleRecord(result.output) && typeof result.output.output === "string") {
    result.output.output = captureDevinShellResult(executionID, result.output.output, metadata)
  }
  if (typeof result.content === "string") {
    result.content = sanitizeRegisteredDevinShellOutput(executionID, result.content)
  } else if (Array.isArray(result.content)) {
    result.content = result.content.map((item: unknown) => {
      if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") return item
      return {
        ...item,
        text: sanitizeRegisteredDevinShellOutput(executionID, item.text),
      }
    })
  } else if (typeof result.output === "string" && result.content === undefined) {
    result.content = result.output
  }
  if (isExtensibleRecord(result.metadata) && typeof result.metadata.output === "string") {
    result.metadata.output = sanitizeRegisteredDevinShellOutput(executionID, result.metadata.output)
  }
}

function asAsyncIterator(stream: unknown): AsyncIterator<unknown> | undefined {
  if (!isRecord(stream) && typeof stream !== "object") return undefined
  if (!stream || typeof stream !== "object") return undefined
  const asyncIterable = stream as { [Symbol.asyncIterator]?: unknown; next?: unknown }
  const iterate = asyncIterable[Symbol.asyncIterator]
  if (typeof iterate === "function") {
    const iterator = iterate.call(stream) as AsyncIterator<unknown> | undefined
    if (iterator && typeof iterator.next === "function") return iterator
  }
  if (typeof asyncIterable.next === "function") return stream as AsyncIterator<unknown>
  return undefined
}

function closeEventSource(source: unknown, iterator?: AsyncIterator<unknown>): void {
  const seen = new Set<unknown>()
  for (const target of [iterator, source]) {
    if (!target || typeof target !== "object" || seen.has(target)) continue
    seen.add(target)
    const closer = target as {
      unsubscribe?: () => void
      cancel?: () => void
      close?: () => void
      return?: () => unknown
    }
    try { closer.unsubscribe?.() } catch { /* host cleanup is best-effort */ }
    try { closer.cancel?.() } catch { /* host cleanup is best-effort */ }
    try { closer.close?.() } catch { /* host cleanup is best-effort */ }
    try { void closer.return?.() } catch { /* host cleanup is best-effort */ }
  }
}

function markCompactionAndOptions(
  event: { sessionID: string; options?: Record<string, unknown> },
  isCompaction: boolean,
): void {
  markCompactionSession(event.sessionID, isCompaction)
  // Keep the request-local flag authoritative. Explicit false prevents a
  // concurrent title/generate/primary request for the same session from
  // inheriting the process-wide fallback marker. Frozen host objects keep
  // the marker and skip the write instead of throwing.
  writeSessionOption(event, DEVIN_COMPACTION_OPTION, isCompaction)
}

const plugin: Plugin2 & { server: typeof DevinPlugin } = {
  id: "devin.provider",
  server: DevinPlugin,

  setup: async (ctx: PluginContext): Promise<Cleanup> => {
    const cacheDir = opencodeGlobalCacheDir()
    const workspaceRoot = ctx.location?.directory || process.cwd()
    const hasShellEnvHook = typeof ctx.shell?.hook === "function"

    const registrations: Array<{ dispose: () => Promise<void> }> = []
    const track = async (p: Promise<{ dispose: () => Promise<void> }>) => {
      registrations.push(await p)
    }

    let models: ModelInfo[] = []
    let sourceConnection: ConnectionInfo | undefined
    let credentialGeneration = 0
    let stagedGeneration = 0
    let clearWhenEmpty = false
    let disposed = false

    // ── Credentials ─────────────────────────────────────────
    await track(ctx.integration.transform(applyDevinIntegration))

    let cachedToken: string | undefined
    let cachedTokenGeneration = -1
    let tokenGeneration = 0
    let tokenInflight: { generation: number; promise: Promise<string | undefined> } | undefined
    /**
     * Cache only a *successful* resolution, and only for the credential
     * generation that produced it.
     *
     * On a fresh install `setup()` runs before the user has connected, so the
     * first attempt necessarily returns nothing. Memoizing that would pin the
     * plugin to "no credentials" for the whole process and models would never
     * load, even after a successful /connect. A switch bumps `tokenGeneration`
     * so an in-flight lookup for the previous account cannot be stored.
     */
    const accessToken = async (): Promise<string | undefined> => {
      const generation = tokenGeneration
      if (cachedToken && cachedTokenGeneration === generation) return cachedToken
      let inflight = tokenInflight
      if (!inflight || inflight.generation !== generation) {
        const promise = resolveDevinAccessToken(ctx.integration).finally(() => {
          if (tokenInflight?.promise === promise) tokenInflight = undefined
        })
        inflight = { generation, promise }
        tokenInflight = inflight
      }
      const token = await inflight.promise
      if (tokenGeneration !== generation) return accessToken()
      if (token) {
        cachedToken = token
        cachedTokenGeneration = generation
      }
      return token
    }

    const refreshSourceConnection = async (): Promise<void> => {
      try {
        sourceConnection = await ctx.integration.connection.active(DEVIN_INTEGRATION_ID)
      } catch {
        sourceConnection = undefined
      }
    }

    // ── Provider inventory (in-memory `editor.add`) ─────────────────────
    // Transform replays on provider.reload(). An empty list is a no-op until
    // a credential switch asks to clear; discovery/cache then reload.
    await track(
      ctx.provider.transform((editor) => {
        if (disposed || stagedGeneration !== credentialGeneration) return
        applyDevinProviderInventory(editor, models, sourceConnection, { clearWhenEmpty })
      }),
    )

    try {
      const cached = await readCache(cacheDir)
      if (cached?.models?.length) {
        models = cached.models
        stagedGeneration = credentialGeneration
        clearWhenEmpty = false
        await refreshSourceConnection()
        await ctx.provider.reload()
      }
    } catch {
      // Cache seed is best-effort; auth/aisdk still work without it.
    }

    const publishModels = async (
      next: ModelInfo[],
      generation: number,
      options: { clearWhenEmpty?: boolean } = {},
    ): Promise<boolean> => {
      if (disposed || generation !== credentialGeneration) return false
      const previousModels = models
      const previousConnection = sourceConnection
      const previousStaged = stagedGeneration
      const previousClear = clearWhenEmpty
      models = next
      stagedGeneration = generation
      clearWhenEmpty = options.clearWhenEmpty ?? false
      await refreshSourceConnection()
      if (disposed || generation !== credentialGeneration) {
        // A newer publish already replaced this snapshot. Writing the old
        // list back would resurrect the previous account after a switch.
        if (stagedGeneration === generation) {
          models = previousModels
          sourceConnection = previousConnection
          stagedGeneration = previousStaged
          clearWhenEmpty = previousClear
        }
        return false
      }
      try {
        await ctx.provider.reload()
      } catch {
        // Keep the transform backed by the last inventory that actually
        // reloaded. A later host replay must not publish a failed account
        // refresh merely because the candidate remained in this closure.
        if (stagedGeneration === generation) {
          models = previousModels
          sourceConnection = previousConnection
          stagedGeneration = previousStaged
          clearWhenEmpty = previousClear
        }
        return false
      }
      return !disposed && generation === credentialGeneration
    }

    // ── AI SDK wiring ────────────────────────────────────────
    await track(
      ctx.aisdk.hook("sdk", async (event) => {
        if (event.sdk) return
        if (!isDevinPackage(event.package, event.model.providerID)) return
        const token = await accessToken()
        event.sdk = createSdk({
          name: event.model.providerID || DEVIN_PROVIDER_ID,
          ...(token ? { accessToken: token } : {}),
          // Static fallback only. This hook fires once per model/package, not
          // per session, and 2.0 runs one daemon across many projects — the
          // real per-request directory comes from the session.context hook
          // below via `getSessionDirectory`, which `language-model.ts` prefers.
          workspaceRoot,
          cacheDir,
          ...event.options,
        } as CreateDevinOptions)
      }),
    )

    await track(
      ctx.aisdk.hook("language", (event) => {
        if (event.language) return
        if (event.model.providerID !== DEVIN_PROVIDER_ID) return
        const languageModel = languageModelFromSdk(event.sdk)
        if (!languageModel) return
        event.language = languageModel(event.model.modelID || event.model.id)
      }),
    )

    // ── Web search ───────────────────────────────────────────
    // Publish an OpenCode 2.0 `websearch` provider (`{url,title,content,time}`).
    // The classic entrypoint owns the permission-aware `custom_websearch`
    // fallback; 2.0's public plugin tool context cannot request permission.
    if (ctx.websearch) {
      await track(
        ctx.websearch.transform((draft) => {
          draft.add({
            id: "devin-exa",
            name: "Exa",
            execute: async (input, context) => {
              const output = await fetchOpenCodeWebSearchText(input, context?.signal)
              return parseExaWebSearchResults(output)
            },
          })
        }),
      )
    }

    await track(
      ctx.tool.transform((draft) => {
        // OpenCode 2 dropped host todowrite/todoread. Off by default
        // (`DEVIN_OPENCODE2_TODOS=1`/`true` force-enables). When on, register
        // them as direct catalog tools (`codemode: false` + output schema) if
        // the host does not already own those names. When off, register none.
        // Do not advertise a stub image-save: public ToolContext cannot ask
        // for write permission, and Devin has no generate-image protocol.
        registerTodoTools(draft)
      }),
    )

    // ── Shell timeout wrapper ────────────────────────────────
    await track(
      ctx.tool.hook("execute.before", (event) => {
        if (!isShellTool(event.tool)) return
        if (!isExtensibleRecord(event.input)) return
        const executionID = toolExecutionID(event)
        prepareDevinShellArgs(executionID, event.input, {
          // OpenCode 2.0 `shell.create.before` can inject env for bash/zsh.
          preferWrapperCommand: !hasShellEnvHook,
        })
      }),
    )

    await track(
      ctx.tool.hook("execute.after", (event) => {
        if (!isShellTool(event.tool)) return
        const executionID = toolExecutionID(event)
        try {
          if (event.status !== "completed") return
          // V1: `output` is the model-facing string. V2: `output` is structured
          // per-tool output (shell: `{ output: string, ... }`) and the
          // model-facing text lives on `content`. Non-objects, frozen results,
          // and non-strings pass through without throwing.
          applyCompletedShellResult(executionID, event.result)
        } finally {
          releaseDevinShellEnv(executionID)
        }
      }),
    )

    if (ctx.shell) {
      await track(
        ctx.shell.hook("create.before", (event) => {
          if (!isRecord(event) || !Object.isExtensible(event)) return
          const env = devinShellEnvForCommand(event.command as string | undefined, event.cwd as string | undefined, {
            timeout: typeof event.timeout === "number" ? event.timeout : undefined,
          })
          if (!env) return
          const current = isRecord(event.env) ? event.env : {}
          const merged: Record<string, string | undefined> = {}
          for (const [key, value] of Object.entries(current)) {
            if (typeof value === "string" || value === undefined) merged[key] = value
          }
          event.env = { ...merged, ...env }
        }),
      )
    }

    const rememberSessionDirectory = async (sessionID: string) => {
      try {
        const info = await ctx.session.get({ sessionID })
        markSessionDirectory(sessionID, info.location?.directory)
      } catch {
        // Best effort — falls back to the static workspaceRoot above.
      }
    }

    await track(
      ctx.session.hook("context", async (event) => {
        markCompactionAndOptions(event, event.agent === "compaction")
        writeSessionOption(event, DEVIN_HOST_AGENT_OPTION, event.agent)
        await rememberSessionDirectory(event.sessionID)
      }),
    )

    await track(
      ctx.session.hook("compaction", async (event) => {
        markCompactionAndOptions(event, true)
        await rememberSessionDirectory(event.sessionID)
      }),
    )

    await track(
      ctx.session.hook("generate", async (event) => {
        markCompactionAndOptions(event, false)
        await rememberSessionDirectory(event.sessionID)
      }),
    )

    await track(
      ctx.session.hook("title", async (event) => {
        markCompactionAndOptions(event, false)
        await rememberSessionDirectory(event.sessionID)
      }),
    )

    // ── Model discovery ────────────────────────────────────────
    let modelsLoaded = false
    let loadedCredentialGeneration = 0
    let ensureInflight: Promise<void> | undefined
    const ensureModels = (): Promise<void> => {
      if (disposed) return Promise.resolve()
      if (modelsLoaded && loadedCredentialGeneration === credentialGeneration) {
        return Promise.resolve()
      }
      // If credentials change during an existing discovery, wait for that
      // attempt and immediately run again. The generation check prevents the
      // older attempt from suppressing the account-scoped refresh.
      if (ensureInflight) return ensureInflight.then(() => ensureModels())

      const attemptGeneration = credentialGeneration
      const forceRefresh = loadedCredentialGeneration !== attemptGeneration
      ensureInflight = (async () => {
        try {
          const token = await accessToken()
          const discovered = await loadModels(cacheDir, token, forceRefresh)
          if (credentialGeneration !== attemptGeneration) return
          if (!discovered.length) {
            // A forced refresh follows a credential switch. Publishing nothing
            // here used to leave the previous account's models in the picker.
            if (forceRefresh) await publishModels([], attemptGeneration, { clearWhenEmpty: true })
            return
          }
          if (!await publishModels(discovered, attemptGeneration)) return
          // A newer credential event arrived while this request was in flight.
          // Keep the state dirty so the chained ensure uses the latest token.
          if (credentialGeneration !== attemptGeneration) return
          modelsLoaded = true
          loadedCredentialGeneration = attemptGeneration
        } finally {
          ensureInflight = undefined
        }
      })()
      return ensureInflight
    }

    const RETRY_INTERVAL_MS = 3_000
    const RETRY_WINDOW_MS = 300_000
    const startedAt = Date.now()
    const retry = setInterval(() => {
      if (modelsLoaded || Date.now() - startedAt > RETRY_WINDOW_MS) {
        clearInterval(retry)
        return
      }
      void ensureModels().catch(() => {})
    }, RETRY_INTERVAL_MS)
    ;(retry as unknown as { unref?: () => void }).unref?.()

    void ensureModels().catch(() => {})

    const onCredentialSwitch = () => {
      cachedToken = undefined
      cachedTokenGeneration = -1
      tokenGeneration++
      modelsLoaded = false
      credentialGeneration++
      void publishModels([], credentialGeneration, { clearWhenEmpty: true }).catch(() => {})
    }

    const unsubscribe = subscribeSessionActivity(ctx, ensureModels, onCredentialSwitch)

    return async () => {
      disposed = true
      clearInterval(retry)
      unsubscribe?.()
      clearCompactionSessions()
      clearSessionDirectories()
      clearAllSessionTodos()
      clearDevinShellTracking()
      for (const registration of registrations.reverse()) {
        await registration.dispose().catch(() => {})
      }
    }
  },
}

function subscribeSessionActivity(
  ctx: PluginContext,
  onEvent?: () => void,
  onCredentialSwitch?: () => void,
): (() => void) | undefined {
  try {
    const stream = ctx.event.subscribe()
    const iterator = asAsyncIterator(stream)
    if (!iterator && !isRecord(stream)) return undefined
    let stopped = false
    const stop = () => {
      if (stopped) return
      stopped = true
      closeEventSource(stream, iterator)
    }
    if (iterator) {
      void (async () => {
        try {
          while (!stopped) {
            const next = await iterator.next()
            if (stopped || next.done) break
            applySessionActivity(next.value, onCredentialSwitch)
            onEvent?.()
          }
        } finally {
          if (!stopped) closeEventSource(stream, iterator)
        }
      })().catch(() => {})
    }
    return stop
  } catch {
    return undefined
  }
}

function applySessionActivity(event: unknown, onCredentialSwitch?: () => void): void {
  if (!isRecord(event)) return
  const payload = eventPayload(event)
  const info = isRecord(payload.info) ? payload.info : undefined
  switch (event.type) {
    case "credential.switched":
    case "credential.updated": {
      const integrationID = payload.integrationID
      if (typeof integrationID !== "string" || integrationID === DEVIN_INTEGRATION_ID || integrationID === DEVIN_PROVIDER_ID) {
        onCredentialSwitch?.()
      }
      break
    }
    case "session.deleted": {
      const sessionID = payload.sessionID
      const infoID = info?.id
      const id = typeof sessionID === "string" ? sessionID : typeof infoID === "string" ? infoID : undefined
      if (id) {
        clearSessionTodos(id)
        markCompactionSession(id, false)
        clearSessionDirectory(id)
      }
      break
    }
    default:
      break
  }
}

export default plugin
