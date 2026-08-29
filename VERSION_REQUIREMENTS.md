# Version Requirements and Dependencies

This document tracks hardcoded version dependencies in the devin-opencode-provider that may require updates when external services change.

## Hardcoded Versions in Code

### Protocol Metadata (src/protocol/metadata.ts)

**Current versions (lines 26-27):**
```typescript
const extVer = opts.extensionVersion ?? "1.48.2"
const ideVer = opts.ideVersion ?? "3.6.27"
```

**Purpose:** These versions are sent in the Connect-RPC metadata to match the official Devin IDE client signature.

**Source:** Derived from Devin IDE 3.7.25 decompiled binary analysis ("Golden 00007").

**When to update:**
- When Devin IDE releases a new major version that changes protocol expectations
- If authentication or API calls start failing with version mismatch errors
- When protocol debugging shows newer versions in official client traffic

**How to update:**
1. Capture network traffic from the latest Devin IDE
2. Locate the `exa.codeium_common_pb.Metadata` message in Connect-RPC calls
3. Update the extension and IDE version strings to match
4. Test authentication and model discovery flows

**Risk assessment:** High - incorrect versions may cause authentication failures or API rejections.

### API Endpoints (src/shared.ts)

**Current endpoints (lines 10-14):**
```typescript
// Latest endpoints verified against Devin IDE 3.7.25 decompiled:
// - Auth authorize: https://app.devin.ai/auth/cli/continue (PKCE S256)
// - Auth token exchange: https://api.devin.ai/auth/cli/token
// - API (chat, GetUserStatus, GetUserJwt): https://server.codeium.com
// - Alt inference: https://api.codeium.com (legacy, not used for chat)
```

**When to update:**
- When Devin announces endpoint changes
- If API calls start failing with 404/403 errors
- When new authentication flows are introduced

**How to verify:**
- Check Devin official documentation
- Monitor decompiled IDE for endpoint changes
- Test OAuth flow end-to-end

## Dependency Versions

### Package Dependencies (package.json)

**Current critical dependencies:**
```json
{
  "dependencies": {
    "@ai-sdk/provider": "3.0.15"
  },
  "peerDependencies": {
    "@opencode-ai/plugin": "^1.17.13"
  },
  "devDependencies": {
    "@opencode-ai/plugin": "^1.18.16",
    "@tsconfig/node22": "^22.0.6",
    "typescript": "^5.9.3"
  }
}
```

**Update recommendations:**
- `@ai-sdk/provider`: Follow AI SDK releases for protocol changes
- `@opencode-ai/plugin`: Update when OpenCode introduces new plugin hooks
- `typescript`: Update for new language features, but test thoroughly

## Testing Version Compatibility

When updating any hardcoded version:

1. **Test authentication flow:**
   ```bash
   opencode auth login
   # Choose devin provider and test both OAuth and API key methods
   ```

2. **Test model discovery:**
   ```bash
   # Check that models are fetched and cached correctly
   cat ~/.cache/opencode/devin-models.json
   ```

3. **Test chat functionality:**
   ```bash
   opencode run --model devin/swe-1-6 "Hello test"
   ```

4. **Monitor for errors:**
   ```bash
   DEVIN_PROVIDER_DEBUG=1 opencode run --model devin/swe-1-6 "test"
   # Check debug log for protocol errors
   ```

## Version Monitoring

### Sources for version updates:
- Devin IDE release notes
- Devin API documentation
- OpenCode plugin changelog
- AI SDK release notes

### Automated monitoring:
Consider setting up automated tests that check:
- Authentication success rate
- Model discovery success rate
- Chat API response times
- Protocol error rates

## Rollback Procedure

If a version update causes issues:

1. Revert the version change
2. Clear model cache: `rm ~/.cache/opencode/devin-models.json`
3. Restart OpenCode to reload the plugin
4. Test with the previous version
5. File an issue documenting the problem

## Version History

| Date | Component | Old Version | New Version | Reason |
|------|-----------|-------------|-------------|--------|
| 2026-08-29 | metadata.ts | - | 1.48.2/3.6.27 | Initial implementation from Devin IDE 3.7.25 |
