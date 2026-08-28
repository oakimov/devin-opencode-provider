# Development Notes

This directory contains development notes and lessons learned during development.

## Lessons learned

### Usage parsing
- Devin sends usage data in frame #7 (ModelUsageStats) and frame #28 (ResponseStatistics)
- Need to decode both and map to LanguageModelV3Usage
- Emit usage only once at turn end to avoid double-counting

### Model discovery
- Use GetCascadeModelConfigs as primary source
- Fall back to GetUserStatus if cascade fails
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
