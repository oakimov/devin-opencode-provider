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

### Authentication
- PKCE flow through api.devin.ai/auth/cli/continue
- Token exchange at api.devin.ai/auth/cli/token
- Session tokens cached and refreshed automatically

### Metadata
- Must match golden capture format (1.48.2, 3.6.27, mac, Free)
- Paths: bff, editor, cli, server, agent
