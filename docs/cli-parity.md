# CLI Parity with Devin

This provider aims to provide parity with the Devin CLI's behavior in OpenCode.

## Authentication

| Method | Devin CLI | devin-opencode-provider |
|--------|-----------|------------------------|
| Browser OAuth | `devin auth login` | `opencode auth login` → **devin** |
| API Key | `devin auth login --api-key` | Same with API key option |

## Model selection

Devin CLI: `devin chat --model swe-1-6-slow`
OpenCode: `opencode run --model devin/swe-1-6-slow`

## Streaming

Both providers support:
- Text deltas
- Reasoning/thinking deltas
- Tool calls
- Usage statistics

## Cache behavior

Devin CLI caches models under `~/.cache/devin/`
This provider caches under `<host-cache>/devin-models.json` (default `~/.cache/opencode/`)

## Differences

- OpenCode uses AI SDK LanguageModelV3 interface
- Devin CLI uses direct Connect-RPC
- Token counting may differ slightly due to different measurement points
