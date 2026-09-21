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

The provider announces `[devin-provider] DEVIN_PROVIDER_DEBUG logging to …`.
A fresh empty file gets a process header on first init. Re-init in the same
override path (module reload, second isolate) **appends** another header
(`reinit=append`) instead of wiping earlier lines. Independently, once the
file reaches 10 MiB the next `trace` call truncates it and writes
`debug: size-cap truncate` so growth stays bounded. Truncate the override
path yourself before a clean run.

### Self-verify markers

With debug enabled, each real turn should emit:

| Prefix | Meaning |
|--------|---------|
| `extractTools:` | Incoming → advertised tool catalog |
| `outbound Run:` | Turn start (model, cascade, tools, message sizes) |
| `hash systemPrompt` / `hash prefix` | Continuity fingerprints of prompt + tools |
| `GetChatMessage protoBytes=` | Actual GetChatMessage protobuf size |
| `host tool dialect:` | `filePathKey` + shell tool + catalog |
| `exec: EMITTED tool-call` | Each tool call sent to the host |
| `finish: reason=` | Turn end + usage totals |
| `turn usage validation:` | `status=ok` / `mismatch` |
| `cache diagnosis:` | `continuity=warm\|cold`, `prefixHash`, `perModelCallCache=unavailable` |

`outbound Run:` does not invent RequestContext, skills, checkpoints, or
`runRequestBytes`. Compare cache with `rawReadVsPriorContext` or, when
`cacheRead > input`, `reconstructedHit`.

Live paste-ready prompt:
`opencode-plugin-compat/docs/guides/devin-ocp-self-verify.md`.

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
