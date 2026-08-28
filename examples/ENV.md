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
