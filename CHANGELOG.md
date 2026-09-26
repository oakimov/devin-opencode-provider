# Changelog

## Unreleased

### CLI wire parity

- Default Cascade identity is the released Devin CLI (`devin-cli` / `chisel` `3000.6.2`). `DEVIN_CLIENT_IDENTITY=windsurf` keeps the Desktop metadata.
- Metadata sends `userJwt` (field 21) and a `devin-session-token$` API key prefix.
- `GetUserJwt` `customApiServerUrl` selects the Cascade host unless `DEVIN_API_BASE_URL` or `WINDSURF_API_BASE_URL` is set.
- CLI identity discovers models with `GetCliModelConfigs` first. AssignModel routers stay standalone. Harness-backed composite routers are omitted.
- Router turns call `AssignModel`, then `GetChatMessage` with the assigned uid and assignment JWT. `actualModelUid` is on `providerMetadata.devin`.
- Stream credit fields and a non-blocking seat snapshot are on `providerMetadata.devin`.
- Gemini tool schemas drop nullable type unions. A large-history `invalid_argument` / `internal error` trailer becomes a non-retryable context-overflow error.

Live account bake-off (catalog size, a router turn, an enterprise base) is still manual.
