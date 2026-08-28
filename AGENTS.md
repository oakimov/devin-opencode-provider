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

Devin models may expose parameterized variants (effort, thinking, context tier). These are materialized as OpenCode model variants.

## Cache behavior

- Model list cached under `<host-cache>/devin-models.json`
- Cache TTL: 24 hours
- Refreshed on startup when cache is empty but credentials exist
