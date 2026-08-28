# Security

## Trust model

- Project `instructions` may reference absolute or `~/` paths (OpenCode parity)
- This provider does not read or write secrets to the repository
- All authentication tokens are stored in the host's auth store (`~/.local/share/opencode/auth.json` for OpenCode)
- Model cache and conversation state are stored under the host cache directory (`~/.cache/opencode/` by default)

## OPENCODE_DISABLE_PROJECT_CONFIG

Set `OPENCODE_DISABLE_PROJECT_CONFIG=1` to disable reading project `instructions` files. This prevents the provider from including local project configuration in the system prompt.

## Token handling

- OAuth tokens are exchanged via PKCE flow through `api.devin.ai`
- API keys are stored securely in the host's auth store
- Session tokens are cached and refreshed automatically when near expiry
