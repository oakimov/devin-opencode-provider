# Development Notes

This directory contains development notes and lessons learned during development.

## Lessons learned

### Debug log lifecycle
- Mid-run module reload must **append** to `DEVIN_PROVIDER_DEBUG_FILE`
  (`reinit=append`), not truncate — otherwise earlier lines disappear while
  the host transcript still has them.
- Cap the file at 10 MiB: `trace` size-caps with `debug: size-cap truncate`
  so unbounded debug runs cannot fill disk. Operators truncate once before a
  clean run.
- Self-verify greps `outbound Run:`, `extractTools:`, `EMITTED tool-call`,
  `turn usage validation:`, `cache diagnosis:` with `perModelCallCache=unavailable`.
  Keep those prefixes stable. Do not invent RequestContext, skills, or
  checkpoint fields on the Devin lines.

### Usage parsing
- Devin sends usage data in frame #7 (ModelUsageStats) and frame #28 (ResponseStatistics)
- Need to decode both and map to LanguageModelV3Usage
- Emit usage only once at turn end to avoid double-counting

### Model discovery
- CLI identity calls `GetCliModelConfigs` first, then `GetCascadeModelConfigs`, then `GetUserStatus`. Desktop identity (`DEVIN_CLIENT_IDENTITY=windsurf`) keeps Cascade first. See “CLI Cascade wire” below.
- Fall back to `GetUserStatus` if the model-config RPCs fail
- Parse ClientModelConfig fields: #22 model_uid, #1 label, #4 disabled
- Cache schema version bumps when catalog shape changes (`devin-models.json`); TTL ~1 day under `~/.cache/opencode/`
- Plan filtering hides most models unless `DEVIN_PROVIDER_SHOW_DISABLED=1` — Pro may only show `swe-1-6-slow` without it

### Catalog / variants (Cursor shape)
- Devin returns **flat** uids; OpenCode should expose **one base id + parameter-only variants**, never a second `devinModelId` on each variant (that re-flattens the picker)
- Group **display-name-first** (`parseDisplayVariants` / `DISPLAY_VARIANT_PHRASES`); id-suffix peeling is fallback only — labels disagree with ids (`-priority` vs “Fast”, opaque `MODEL_PRIVATE_*`)
- Register wire-id aliases for opaque PRIVATE_* uids; synthesize others with `wireModelIdFromBaseAndParams` at stream time
- Keep `-1m` as a **separate base** (`claude-opus-4-6` vs `claude-opus-4-6-1m`); do not fold context tier into Max Mode
- Strip redundant “Thinking” from labels when ≥2 effort×thinking variants exist; keep “No Thinking”
- Set `reasoning: true` if **any** member `supportsThinking` or any thinking/effort variant — don’t inherit only the non-thinking representative
- Variant sort: Lightning **before** effort in the key so SWE is `Medium, Max, Lightning Medium, Lightning Max` (not interleaved); then effort; then Fast within effort (`Low, Low Fast, …`)
- **Max ≠ Cursor Max Mode**: Devin has no `max_mode` toggle; Max is `effort=max`. Cursor Max Mode ≈ long-context / `max_mode` wire flag

### Plugin / OpenCode host
- OpenCode 2.0 inventory is `ctx.provider.transform` + `editor.add` + `sourceConnection`, not `ctx.catalog`. Dual-export `{ id, setup, server: DevinPlugin }` on `./plugin/opencode2` and `./server`. Plugin `todowrite`/`todoread` stay off unless `DEVIN_OPENCODE2_TODOS=1`/`true`. Do not advertise `devin_image_save` on 2.0 (public `ToolContext` cannot request permissions). Extra classic hooks (`tool.execute.*`, `shell.env`, `chat.params`) drop `Hooks` contextual typing in this facade — annotate parameters or the whole return object goes implicit-any.
- Always assign `existing.models = modelsToConfig(...)` on config load (Cursor does this). Skipping when `existing.models` is nonempty leaves a **stale** catalog in long-lived TUI sessions after rebuild
- After `bun run build`, fully restart the TUI; CLI `opencode models` / a one-shot `modelsToConfig` dump can look correct while an old process still shows flat or wrong order
- Older OpenCode TUI may have sorted variant titles with `localeCompare`; research trees sometimes comment that out — if CLI order is right but TUI isn’t, check host dialog sort before changing our insertion order again

### Authentication
- PKCE flow through api.devin.ai/auth/cli/continue
- Token exchange at api.devin.ai/auth/cli/token
- Session tokens cached and refreshed automatically

### Metadata
- Must match golden capture format (1.48.2, 3.6.27, mac, Free)
- Paths: bff, editor, cli, server, agent

### Agent tooling
- Keep `oldString` minimal but unique (2-3 lines with indentation) to avoid ambiguous matches.
- Do not commit/push unless the user asks

### File-tool arg names (read/edit/write)
- OpenCode 1.x requires `filePath`; OpenCode 2.0 requires `path`. Devin emits `filePath`.
- Never rewrite to only `path` and drop `filePath` — host validation is `SchemaError(Missing key at ["filePath"])`.
- Inspect the advertised JSON schema; if unknown, keep **both** keys. See `src/protocol/file-tool-args.ts`.

### Devin 3.9.19 wire (2026-09-09)
- `GetChatMessageRequest.#27 prompt_cache_key` — send stable key (OpenCode `x-session-id` / cascade id); do not invent a new UUID every turn.
- `prompt_id` is **#17**, `execution_id` is **#22** (older builds wrongly put promptId on #22).
- `ChatMessagePrompt.#20 VideoData` / `#21 DocumentData` — encode OpenCode `file` parts (not text placeholders).
- Parse `ModelInfo.#6 ModelFeatures` for `#11` images, `#15` thinking, `#27` video, `#29` documents; advertise OpenCode `pdf` modality when documents are on.
- Skip catalog uid `subagent-default` (Task wire token, not a chat model).
- `control_type` on family metadata is CLI-picker-only; OpenCode variants still come from display-name peeling.
- Inject extracted attachments onto the last user message — extraction alone is not enough.

### Thinking / `</think>` leak (2026-09-19)
- GetChatMessage `#9` is structured reasoning, `#3` is visible text (`docs` in the mock server). SWE/Qwen/Muse models still emit `<think>…</think>` **on #3**.
- Closing reasoning before `text-start` is required (AI SDK V3) but does **not** strip the tags. Literal `</think>` in OpenCode is in-band markup on the text channel.
- Split tags cross-chunk (`src/think-tags.ts`, same hold as `cursor_mock/llm/client.py _feed_think_tags`) and drop stray `</think>` with no open tag. Replay the inner body on history `#11`, never as `#3`.
- Flush the hold buffer before tool-call / finish; reopen reasoning with a new span id after `</think>`.

### Empty model cache must not be "fresh" (2026-09-09)
Schema bump + a failed/empty discovery wrote `devin-models.json` with
`models: []` and a current `fetchedAt`. `isCacheFresh` treated it as valid
for 24h → OpenCode opened with Devin uninitialized (no models). Fix: empty
caches are never fresh; refuse to write empty; discovery returning 0 throws
so stale non-empty cache can still be served. Delete
`~/.cache/opencode/devin-models.json` once to recover immediately.

### Tool catalog sort/hold (2026-09-21)
- Do not re-sort tools on every encode. JSON-schema keys stay UTF-16
  canonicalized; list order is the advertised epoch.
- First nonempty freeze is UTF-16 by name. Equal names keep frozen
  descriptors. New names append (UTF-16 among newcomers). Re-sorting a
  grow that appends `bash` after `write` retokenizes the tools prefix.
- Shrink drops omitted names, because every advertised tool is
  host-executable. Compaction still sends `tools=[]` so the summarizer
  cannot call tools.

### OpenCode 2 MCP catalog placement (2026-09-26)
- Do not write MCP server `codemode` to put tools on the direct catalog: that
  field also decides whether OpenCode appends `?codemode=false` so a remote
  server returns individual tools. Placement is the tool's `options.codemode`,
  set to `false` via `ctx.tool.transform` for namespaces whose server did not
  explicitly set `codemode: true`.
- Host `<mcp_instructions>` still say "use `execute`" from server config, so
  provider guidance must prefer the direct name when the tool is listed.
- A first prompt sent before MCP servers finish connecting sees no MCP tools;
  the next turn does. Do not delay startup or the first request for MCP.

### OpenCode 2 workspace directory (2026-09-26)
- The 2.0 daemon's cwd is not the project. Resolve `x-opencode-directory`
  (URI-encoded) first, then `ctx.session.get()` flat `info.directory`, then
  legacy `info.location.directory`, then static option/cwd.

### CLI Cascade wire (2026-09-26)
- Default Metadata is released Devin CLI: `ideName=devin-cli`, `ideType=chisel`, versions `3000.6.2`, real `os` (`darwin` / `windows` / `linux`). `DEVIN_CLIENT_IDENTITY=windsurf` is the Desktop rollback (`1.48.2` / `3.6.27` / `mac`). Do not flip identity without that flag.
- `GetCliModelConfigs` uses a different identity: `chisel` / `0.0.0-dev`, and must advertise display slots 3, 4, 6, 7, 8. Slots 4 and 6 are hidden after the response. That call is first only for the CLI identity.
- `Metadata.userJwt` is field 21. Chat sets it. `AssignModel`, discovery, and seat status leave it empty. `Metadata.apiKey` always carries a single `devin-session-token$` prefix.
- `GetUserJwt` field 2 `customApiServerUrl` is the Cascade host unless `DEVIN_API_BASE_URL` or `WINDSURF_API_BASE_URL` is set. Mint the JWT against the explicit host, then switch.
- `AssignModel` and the following `GetChatMessage` must share `cascadeId`. The router prompt is the current user text only, with an empty `messageId`. On failure, do not send the router uid as `chatModelUid`. Chat field 21 is the assigned uid; field 26 is `modelAssignmentJwt`.
- A router flag with harness uids is a composite pairing, not an AssignModel target. Omit it. A router flag with an empty harness list (`adaptive`) is `requiresAssignModel` and must stay a standalone base — not an effort variant. `subagent-default` stays hidden.
- Cache schema 5: `requiresAssignModel` is new. Old `devin-models.json` files are stale until refresh.
- Gemini / `MODEL_GOOGLE_GEMINI_*` tool schemas must drop type unions like `["number","null"]` before encode.
- Early Connect trailer `invalid_argument` + “internal error”, before any output, with shrinkable history ≥ 512 KiB, is a non-retryable `prompt is too long` / `context_length_exceeded` error. Log it on the existing `GetChatMessage trailer error` line, including `protoBytes`, `framedBytes`, and `historyBytes`.
- Seat status and turn credits are `providerMetadata.devin` plus debug lines `seat status:` and `turn credits:`. Do not block chat on status failure, and do not fold credits into the `cache diagnosis:` line.

### Path grounding is keyed on exact host tool names (2026-09-26)
- Only canonical `read`, `grep`, `glob`, `bash`, `shell` results are
  grounded. Name-segment matching rewrote MCP output (`db_execute`,
  `github_read_file`) and OpenCode 2 Code Mode `execute`, whose result is a
  returned string or JSON (`packages/core/src/codemode/tool.ts` formatResult):
  `feature/x`, `owner/repo`, `image/png` became invented workspace paths.
