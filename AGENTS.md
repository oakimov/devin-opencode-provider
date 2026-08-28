# devin-opencode-provider

OpenCode plugin + AI SDK provider that runs Devin subscription models by speaking Devin's Connect-RPC Cascade protocol (`server.codeium.com`, not a generic chat-completions API). Mirrors `cursor-opencode-provider` structure for OpenCode.

**Stack:** TypeScript (ESM), Bun for install/test, `tsc` for build. Optional peer: `@opencode-ai/plugin@^1.17.13` (devDependency pinned to `^1.18.16`). Deps: `@ai-sdk/provider@3.0.15`. Devin/Windsurf backend: Connect-RPC `GetCascadeModelConfigs` / `GetUserStatus` / `GetUserJwt` / `GetChatMessage` at `https://server.codeium.com`.

## Provider behavior

- **Provider ID**: `devin`
- **Authentication**: OAuth PKCE via `api.devin.ai` or API key
- **Model discovery**: Fetched from Devin's `GetCascadeModelConfigs` API
- **Streaming**: Full streaming with text, reasoning, and tool calls
- **Usage**: Token counts extracted from Devin's `ModelUsageStats` frames

## Supported features

- Text input/output
- Image input (for supported models)
- Tool calls
- Reasoning/thinking deltas
- Token usage tracking

## Model variants

Devin exposes **flat** `model_uid`s. We group them **display-name-first** into one OpenCode base id with **parameter-only** variants (`devinVariantParameters`). Variants must not carry a second model id. At request time, `language-model.ts` resolves the wire uid via alias table (opaque `MODEL_PRIVATE_*`) or `wireModelIdFromBaseAndParams`.

- **Effort / speed**: `Low`, `Low Fast`, `Medium`, …, `Max`, `Max Fast` (Fast after same effort).
- **SWE Lightning**: all non-Lightning first, then Lightning — `Medium`, `Max`, `Lightning Medium`, `Lightning Max`.
- **Thinking**: redundant “Thinking” labels stripped when the whole ladder is thinking-mode; keep explicit `No Thinking`.
- **Context tier**: `-1m` stays a **separate base** (`claude-opus-4-6` vs `claude-opus-4-6-1m`), not a Max Mode flag.
- **Reasoning**: `reasoning: true` if any group member supports thinking or exposes thinking/effort variants.
- **Plugin**: always overwrites `cfg.provider.devin.models` on config load (do not keep a stale first merge).

There is **no Cursor-style Max Mode** toggle; **Max** = high effort only.
## Cache behavior

- Model list cached under `<host-cache>/devin-models.json`
- Cache TTL: 24 hours
- Refreshed on startup when cache is empty but credentials exist
