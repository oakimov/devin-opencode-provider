# devin-opencode-provider

OpenCode plugin + AI SDK provider that runs Devin subscription models by speaking Devin's Connect-RPC Cascade protocol (`server.codeium.com`, not a generic chat-completions API).

## Non-negotiable provider / compatibility-layer boundary

This package targets **only canonical OpenCode 1.x and OpenCode 2.0 contracts**. Compatibility layers may adapt it externally, but this repository must be completely unaware of them and of every alternate host or sibling provider.

- **No compatibility-layer dependency or identity:** executable source, types, tests, package metadata, and published `dist/` must not import, name, detect, or describe `@opencode-compat/*`, OCP, or any compatibility package.
- **No alternate-host knowledge:** the same surfaces must not name or parse MiMo, Kilo, Pi, OMP, DSH/DeepSeek Harness, their paths, environment variables, tools, schemas, result envelopes, planning behavior, or session events. Evidence learned from another host must be restated as a Devin backend or canonical OpenCode contract before entering this repository.
- **No sibling-provider knowledge:** do not import, reference, mirror, alias, or export names belonging to another provider. In particular, this package must never expose another provider's factory/plugin names or point comments at another provider implementation for rationale.
- **Canonical vocabulary only:** provider runtime code consumes advertised OpenCode tools and schemas. Alternate names and payloads must be normalized by the external compatibility layer before reaching this package. Unknown advertised tools may pass through as opaque catalog data; the provider must never recognize a host-specific tool or result shape.
- **Neutral structural seams only:** optional host capabilities must be structural, host-neutral OpenCode contracts such as `Symbol.for("opencode.host.path-bridge")`; no installer identity or host branch may be observable.
- **Documentation exception:** user-facing documentation may explain that an external compatibility layer can adapt the unchanged provider, but that rationale must never become provider executable code, tests, declarations, aliases, or package metadata.
- **Hard change gate:** after every provider change, build and scan `src/`, tests, `package.json`, lockfile, and published `dist/`, including filenames of ignored files under `dist/`; then inspect `npm pack --dry-run --json`. `test/architecture.test.ts` must fail on compatibility packages, compatibility-generated artifacts, alternate-host vocabulary, sibling-provider identities, static `@opencode-ai/plugin` value imports in classic plugin modules, and `@opencode/plugin` dependencies. Run `bun run check:pricing` (fixture is empty while `pricing-data.ts` is stubbed). If a compatibility behavior cannot be expressed through canonical OpenCode, implement it in OCP instead.

**Stack:** TypeScript (ESM), Bun for install/test, `tsc` for build. Optional peer: `@opencode-ai/plugin@^1.17.13` (devDependency pinned to `^1.18.16`). Deps: `@ai-sdk/provider@3.0.15`. Devin/Windsurf backend: Connect-RPC `GetCascadeModelConfigs` / `GetUserStatus` / `GetUserJwt` / `GetChatMessage` at `https://server.codeium.com`. Quality gates: `bun run typecheck`, `bun test` (includes architecture), `bun run check:pricing`. No ESLint/Biome — TypeScript + domain tests are the linter.

## Provider behavior

- **Provider ID**: `devin`
- **Authentication**: OAuth PKCE via `api.devin.ai` or API key
- **Model discovery**: Fetched from Devin's `GetCascadeModelConfigs` API
- **Streaming**: Full streaming with text, reasoning, and tool calls
- **Usage**: Token counts extracted from Devin's `ModelUsageStats` frames

## Supported features

- Text input/output
- Image input (for supported models)
- Video / document attachments (`VideoData` / `DocumentData` on `GetChatMessage`)
- Tool calls
- Reasoning/thinking deltas (and `#11` thinking replay on history)
- Token usage tracking
- Stable `prompt_cache_key` (#27) from OpenCode session headers

## Model variants

Devin exposes **flat** `model_uid`s. We group them **display-name-first** into one OpenCode base id with **parameter-only** variants (`devinVariantParameters`). Variants must not carry a second model id. At request time, `language-model.ts` resolves the wire uid via alias table (opaque `MODEL_PRIVATE_*`) or `wireModelIdFromBaseAndParams`.

- **Effort / speed**: `Low`, `Low Fast`, `Medium`, …, `Max`, `Max Fast` (Fast after same effort).
- **SWE Lightning**: all non-Lightning first, then Lightning — `Medium`, `Max`, `Lightning Medium`, `Lightning Max`.
- **Thinking**: redundant “Thinking” labels stripped when the whole ladder is thinking-mode; keep explicit `No Thinking`.
- **Context tier**: `-1m` stays a **separate base** (`claude-opus-4-6` vs `claude-opus-4-6-1m`), not a Max Mode flag.
- **Reasoning**: `reasoning: true` if any group member supports thinking or exposes thinking/effort variants.
- **Plugin**: always overwrites `cfg.provider.devin.models` on config load (do not keep a stale first merge).
- **OpenCode 2.0**: load `devin-opencode-provider/plugin/opencode2` (dual-export `{ id, setup, server: DevinPlugin }`). Models publish via `ctx.provider.transform` + `editor.remove` (when present) + `editor.add` + `sourceConnection`. A failed credential switch clears the previous inventory. Plugin todos stay off unless `DEVIN_OPENCODE2_TODOS=1`/`true` and, when on, are in-memory only. Do not advertise `devin_image_save` on 2.0. MCP tools from servers that did not set `codemode: true` get `options.codemode: false` via `ctx.tool.transform` (`src/opencode2/mcp-direct.ts`) so Devin calls them by name; MCP server config is observed through `ctx.mcp.transform` and never written. Workspace root resolves `x-opencode-directory` header → session mark (`info.directory ?? info.location.directory`) → static option/cwd (`src/session-directory.ts`).

There is **no Cursor-style Max Mode** toggle; **Max** = high effort only.
## Cache behavior

- Model list cached under `<host-cache>/devin-models.json`
- Cache TTL: 24 hours
- Refreshed on startup when cache is empty but credentials exist
- **Tool catalog:** first nonempty freeze is UTF-16 by name; equal names keep frozen descriptors and order; new names append (UTF-16 among newcomers); the encoder emits advertised order and only canonicalizes JSON-schema keys. Shrink drops names the host omitted, because every advertised tool is host-executable. Compaction still sends no tools.
