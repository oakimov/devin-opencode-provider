# CLI Parity with Devin

This provider aims to provide parity with the Devin CLI's behavior in OpenCode.

## Authentication

| Method | Devin CLI | devin-opencode-provider |
|--------|-----------|------------------------|
| Browser OAuth | `devin auth login` | `opencode auth login` → **devin** |
| API Key | `devin auth login --api-key` | Same with API key option |

## Model selection

Devin CLI picks a flat wire id. OpenCode picks a **provider/base** plus optional **`--variant`** (this provider collapses effort/speed into variants):

| Devin CLI | OpenCode |
|-----------|----------|
| `devin chat --model swe-1-6-slow` | `opencode run --model devin/swe-1-6-slow` |
| `devin chat --model claude-opus-5-max` | `opencode run --model devin/claude-opus-5 --variant Max` |
| `devin chat --model swe-1-7-lightning` | `opencode run --model devin/swe-1-7 --variant "Lightning Max"` |

**Max** is an effort variant (`effort=max`), not Cursor Max Mode. Long-context models remain separate bases (e.g. `devin/claude-opus-4-6-1m`).

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
- OpenCode model list is **grouped + variants**; Devin CLI typically addresses the raw wire uid
- No Cursor-style Max Mode chrome — use `--variant Max` (effort) or a `*-1m` base for long context
