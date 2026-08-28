# Agent Configuration (AGENTS.md)

This file configures the agent behavior for this provider. It is used by OpenCode and compatible coding agents to understand how to work with this provider.

## Provider behavior

- **Provider ID**: `devin`
- **Authentication**: OAuth PKCE via `api.devin.ai` or API key
- **Model discovery**: Fetched from Devin's `GetCascadeModelConfigs` API
- **Streaming**: Full streaming with text, reasoning, and tool calls
- **Usage**: Token counts extracted from Devin's `ModelUsageStats` frames

## Supported features

- Text input/output
- Image input (for supported models)
- Tool calls
- Reasoning/thinking deltas
- Token usage tracking

## Model variants

Devin models may expose parameterized variants (effort, thinking, context tier). These are materialized as OpenCode model variants.

## Cache behavior

- Model list cached under `<host-cache>/devin-models.json`
- Cache TTL: 24 hours
- Refreshed on startup when cache is empty but credentials exist
