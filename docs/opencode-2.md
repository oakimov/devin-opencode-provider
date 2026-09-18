# OpenCode 2.0

Dedicated entrypoint: `devin-opencode-provider/plugin/opencode2`. Do **not** also load the classic `plugin` entry or `plugin/v2` under OpenCode 2.0 — they target OpenCode 1.x APIs.

## How models register

Discovered Devin models are published **in memory** through `ctx.provider.transform` → `editor.remove` (when the host has it) → `editor.add({ info, models, sourceConnection })` → `ctx.provider.reload()`. The plugin does **not** write a model list into `opencode.json`.

Cache seed (and `/connect` afterwards) refill the inventory. An empty first transform is a no-op. A credential switch replaces that inventory; if the new account cannot be loaded, the previous account's models are removed instead of staying in the picker.

`time.released` is the daemon's start time plus catalog order, not `0`. OpenCode 2.0's picker sorts by `released` descending, so a zero timestamp sinks every Devin model under the fold. Filter by provider **Devin** if you still do not see them in the global list.

## From npm

```json
{
  "plugin": ["devin-opencode-provider/plugin/opencode2"]
}
```

OpenCode 2.0 installs the published package into its host cache and loads the AI SDK entry from there (`aisdk:devin-opencode-provider`).

## Config isolation

`opencode2` defaults to the same `~/.config/opencode` as OpenCode 1.x unless you set `OPENCODE_CONFIG_DIR`. Prefer a dedicated directory so 1.x `plugin` / `provider` entries and 2.0 `plugins/` do not share one file:

```bash
export OPENCODE_CONFIG_DIR=~/.config/opencode2
```

If npm subpath resolution is unreliable, install a **plugin directory** under `$OPENCODE_CONFIG_DIR/plugins/` (OpenCode 2.0 rejects a bare `.js` path — it must be a directory with `package.json`):

```bash
mkdir -p "$OPENCODE_CONFIG_DIR/plugins/devin"
cat > "$OPENCODE_CONFIG_DIR/plugins/devin/package.json" <<'EOF'
{ "name": "devin-local", "type": "module", "main": "./index.js" }
EOF
cat > "$OPENCODE_CONFIG_DIR/plugins/devin/index.js" <<EOF
export { default } from "/absolute/path/to/devin-opencode-provider/dist/plugin-opencode2.js"
EOF
```

## Authenticate

Inside `opencode2`, run `/connect`, choose **Devin**, then browser login or an API key. `DEVIN_API_KEY` / `WINDSURF_API_KEY` are also picked up automatically.

## From a local clone (`DEVIN_OPENCODE2_DEV_ENTRY`)

```bash
cd /absolute/path/to/devin-opencode-provider
bun install && bun run build
export OPENCODE_CONFIG_DIR=~/.config/opencode2
export DEVIN_OPENCODE2_DEV_ENTRY=/absolute/path/to/devin-opencode-provider/dist/index.js
```

Point `DEVIN_OPENCODE2_DEV_ENTRY` at the built provider entry (`dist/index.js`, which exports `createDevin`) so the host imports that file directly instead of `npm.add` for `aisdk:devin-opencode-provider`.

Unset `DEVIN_OPENCODE2_DEV_ENTRY` in production. Rebuild after every change (`bun run build`).

## Feature parity vs the classic plugin

| Classic plugin (OpenCode 1.x) | OpenCode 2.0 plugin |
|---|---|
| `config` hook registers provider + models | `ctx.provider.transform` + `editor.add` + `reload()` |
| `auth` hook (OAuth + API key) | `ctx.integration.transform` + `/connect` |
| `tool` hook (`custom_websearch`) | `ctx.websearch.transform` publishes Exa as `{url,title,content,time}` for the host `websearch` tool. Public 2.0 `ToolContext` cannot request permission, so this entrypoint does not advertise `custom_websearch` or `devin_image_save`. |
| `tool.execute.before` / `.after` | `ctx.tool.hook(...)` |
| `shell.env` injects the timeout wrapper | `ctx.shell.hook("create.before")` injects the same env; wrapper-file fallback remains when that hook is absent |
| `chat.params` flags compaction turns | `session.hook("context")` / `"compaction"` sets `options.opencodeCompaction` and the session marker; `getSessionDirectory` supplies the per-session workspace |
| Host `todowrite` builtin | Plugin-owned `todowrite`/`todoread` stay **off** unless `DEVIN_OPENCODE2_TODOS=1` (or `true`). When on, the list is in-memory only: not a host checklist, not on disk, and cleared on restart, plugin unload, and session delete. OpenCode 1.x still uses the host builtin and is not gated. |
| Host `bash` / `task` | Emitted `bash`/`execute`/`task` remap onto advertised `shell` / `subagent` |
| — | `credential.switched` drops the cached token, removes the previous model inventory, and reloads |
| Package root / `plugin` | OpenCode 2 `Host.resolve` loads `exports["./server"]` → this entry (`{ id, setup }`). The same module dual-exports `server: DevinPlugin` so OpenCode 1.18 still gets the classic plugin. |

This port is shared 2.0 host-compat only. It does not invent a host todo TUI, Cursor SwitchMode, plan-exit kickoff, or Exa `cursor-exa`.
