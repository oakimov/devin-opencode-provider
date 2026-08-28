# Cache and Logging Runbook

## Cache locations

### Model cache
- Path: `<host-cache>/devin-models.json`
- Default: `~/.cache/opencode/devin-models.json`
- TTL: 24 hours
- Refresh: On startup when empty but credentials exist

### Auth cache
- Path: `~/.local/share/opencode/auth.json` (OpenCode)
- Managed by host, not provider

### Conversation state
- Currently not persisted (future enhancement)

## Debug logging

Enable wire-level debug logging:

```bash
export DEVIN_PROVIDER_DEBUG=1
# or
export DEVIN_PROVIDER_DEBUG=1
export DEVIN_PROVIDER_DEBUG_FILE=/path/to/debug.log
```

## Cache troubleshooting

### Empty model list
1. Check auth: `opencode auth login` → **devin**
2. Delete cache: `rm ~/.cache/opencode/devin-models.json`
3. Restart OpenCode

### Stale models
1. Delete cache file
2. Restart OpenCode
3. Models will refresh automatically if auth exists

### Auth errors
1. Re-login: `opencode auth login` → **devin**
2. Check `~/.local/share/opencode/auth.json`
3. Verify account has access to Devin API
