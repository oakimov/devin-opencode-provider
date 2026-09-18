# Environment Variables

## DEVIN_API_KEY

Optional. Your Devin API key (`devin-session-token$...`, `cog_...`, or `sk-...`). If set, the provider uses this key directly without requiring OAuth login.

```bash
export DEVIN_API_KEY=devin-session-token$eyJ...
```

If not set, authentication defaults to OAuth PKCE via `opencode auth login`.

## DEVIN_API_BASE_URL

Optional. Override the Devin API base URL (default: `https://api.devin.ai`).

```bash
export DEVIN_API_BASE_URL=https://api.devin.ai
```

## DEVIN_WEBSITE_URL

Optional. Override the Devin website URL for OAuth (default: `https://app.devin.ai`).

```bash
export DEVIN_WEBSITE_URL=https://app.devin.ai
```

## DEVIN_PROVIDER_DEBUG

Optional. Set to `1` or `true` to enable wire-level debug logging.

```bash
export DEVIN_PROVIDER_DEBUG=1
```

## DEVIN_OPENCODE2_TODOS

Optional. Set to `1` or `true` to advertise plugin-owned `todowrite` / `todoread` on OpenCode 2.0. Default is off — OpenCode 2 has no host todo TUI. OpenCode 1.x still uses the host builtin and is not gated.

```bash
export DEVIN_OPENCODE2_TODOS=1
```

## DEVIN_OPENCODE2_DEV_ENTRY

Optional. Absolute path to a local built `dist/index.js` so OpenCode 2.0 imports the AI SDK entry from disk instead of `npm.add`. Unset in production.

```bash
export DEVIN_OPENCODE2_DEV_ENTRY=/absolute/path/to/devin-opencode-provider/dist/index.js
```

## EXA_API_KEY

Optional. Attached to the Exa MCP URL used by `custom_websearch` (OpenCode 1.x) and the OpenCode 2.0 `websearch` provider.

## XDG_CACHE_HOME

Optional. Base for host cache dirs (default: `~/.cache/opencode/`).

```bash
export XDG_CACHE_HOME=/path/to/cache
```

## XDG_DATA_HOME

Optional. Base for OpenCode auth storage (default: `~/.local/share/opencode/`).

```bash
export XDG_DATA_HOME=/path/to/data
```
