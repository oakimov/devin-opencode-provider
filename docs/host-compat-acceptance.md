# Host Compatibility Acceptance

This provider is designed to work with OpenCode and compatible coding agents.

## Tested hosts

- OpenCode (native)
- OpenCode 2.0 (via dedicated entrypoint)

## Compatibility requirements

- AI SDK LanguageModelV3 interface
- Plugin hooks for auth and model discovery
- Streaming support
- Tool call support

## Future compatibility

Through [OCP - OpenCode Plugin Compatibility](https://github.com/oakimov/opencode-plugin-compat), this provider may be adapted to:
- Kilo Code
- MiMo Code
- pi
- oh-my-pi

## Testing

To test on a new host:
1. Load the plugin via the host's plugin system
2. Authenticate with Devin
3. Select a model
4. Run a chat with tool calls
5. Verify streaming and usage statistics
