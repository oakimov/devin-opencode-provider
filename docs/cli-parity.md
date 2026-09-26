# CLI Parity with Devin

This provider aims to provide parity with the Devin CLI's behavior in OpenCode.

**Implementation plan (Cascade / CLI wire):** [`tasks/plans/omp-cascade-cli-parity.md`](../tasks/plans/omp-cascade-cli-parity.md) — identity (`chisel`), `AssignModel`, CLI discovery, credits/seat status. Separate from OpenCode↔Cursor host parity.

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
- Composite router pairings (a router flag plus harness uids) are omitted. The native client runs the lead locally; this provider does not remap them.
- Plan balances and per-turn credits are `providerMetadata.devin` and `DEVIN_PROVIDER_DEBUG` lines. OpenCode has no plan-credit panel.

## Cascade wire

Default client identity is the released Devin CLI. `DEVIN_CLIENT_IDENTITY=windsurf` restores Desktop metadata. A live account bake-off is manual and is not part of `bun test`.

| Surface | Contract | Tag |
|---------|----------|-----|
| Chat `GetChatMessage` | Connect stream, gzip body, `Connect-Protocol-Version: 1` | port |
| `GetUserJwt` | Field 1 user JWT, field 2 `customApiServerUrl` | port |
| Chat Metadata | `ideName=devin-cli`, `ideType=chisel`, versions `3000.6.2`, `os` is `darwin` / `windows` / `linux` | port |
| Discovery Metadata | `ideName` and `extensionName` `chisel`, versions `0.0.0-dev`, display slots 3, 4, 6, 7, 8 | port |
| Desktop fallback | `DEVIN_CLIENT_IDENTITY=windsurf` keeps `1.48.2` / `3.6.27` / `mac` | port |
| Session token | Every Metadata `apiKey` is prefixed `devin-session-token$` once | port |
| `userJwt` | Metadata field 21. Chat sets it. `AssignModel`, discovery, and seat status do not | port |
| API base | `DEVIN_API_BASE_URL`, else `WINDSURF_API_BASE_URL`, else a non-public configured base, else JWT field 2, else `https://server.codeium.com`. JWT mint uses the explicit base, not the custom URL | port |
| Catalog RPC | CLI identity calls `GetCliModelConfigs` first, then `GetCascadeModelConfigs`, then `GetUserStatus` | port |
| Display filter | Slots 4 (quick-review) and 6 (internal-default) are requested and then hidden | port |
| AssignModel routers | Router flag or display slot 3, and an empty harness list. Catalog flag `requiresAssignModel`. Standalone base, not an effort variant | port |
| Fusion composites | Router flag with harness uids. Omitted from the picker | adapt |
| `subagent-default` | Hidden. Task wire token, not a chat model | port |
| `AssignModel` | Unary. CLI Metadata, router uid, same `cascadeId` as the following chat, current user text only, empty `messageId`. Failure fails the turn | port |
| Chat uid / JWT | `chatModelUid` is field 21. `modelAssignmentJwt` is field 26 | port |
| Prompt cache | Field 13 `EPHEMERAL` plus existing field 27 `prompt_cache_key` | port |
| Routed model | Response field 23 `actualModelUid` on `providerMetadata.devin` | port |
| Token usage | `ModelUsageStats` / response statistics, unchanged LanguageModelV3 mapping | port |
| Turn credits | Response fields 14 `creditCost`, 18 `committedCreditCost`, 22 `committedAcuCost` on `providerMetadata.devin` | port |
| Seat snapshot | CLI-metadata `GetUserStatus`. Plan name, credit buckets, quota windows. Failure does not fail the turn. Debug line `seat status:` | adapt |
| Gemini tools | Wire uid containing `gemini` or starting with `MODEL_GOOGLE_GEMINI_` strips nullable JSON Schema type unions before encode | port |
| Large history | Early trailer `invalid_argument` whose message contains `internal error`, before any output, shrinkable history ≥ 512 KiB → non-retryable `prompt is too long` / `context_length_exceeded` | adapt |
| OpenCode variants, tool freeze, attachments | Unchanged | keep |

Cache schema is `MODEL_CACHE_SCHEMA_VERSION` 5 so catalogs written before `requiresAssignModel` refresh.

### OpenCode exposure

- Router models are normal catalog entries. `opencode run --model devin/adaptive` (or the discovered router id) assigns, then streams. `providerMetadata.devin.assignedModelUid` is the uid from `AssignModel`. `actualModelUid` is what the stream reported.
- Credits and the seat snapshot ride on `providerMetadata.devin`. Debug also prints `turn credits:` and `seat status:` when `DEVIN_PROVIDER_DEBUG=1`.
- There is no host plan-limit API. Do not expect a credit panel.

### Environment

| Variable | Effect |
|----------|--------|
| `DEVIN_CLIENT_IDENTITY` | `cli` (default) or `windsurf` / `desktop` |
| `DEVIN_API_BASE_URL` | Cascade host. Wins over JWT `customApiServerUrl` |
| `WINDSURF_API_BASE_URL` | Legacy alias of the Cascade host override |
| `DEVIN_PROVIDER_DEBUG` | Logs `seat status:` and `turn credits:` |
