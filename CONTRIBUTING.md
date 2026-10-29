# Contributing to devin-opencode-provider

External contributions are welcome. Start with an idea or bug report when the change is non-trivial (see below).

## Before you write code

Post an [idea or proposal](https://github.com/oakimov/devin-opencode-provider/issues) first and wait for maintainer direction for new features, public API or config changes, authentication, Cascade transport or protocol behavior, broad refactors, or dependency bumps. Bugs go to the same issue tracker with the evidence below.

Security vulnerabilities: report privately to the maintainer, using GitHub's private vulnerability reporting when available. Do not open a public issue, discussion or PR with vulnerability details. See [SECURITY.md](./SECURITY.md) for the provider's trust model.

Host-specific work for other coding agents belongs in [OCP](https://github.com/oakimov/opencode-plugin-compat), not here. This package targets canonical OpenCode 1.x and 2.0 contracts and remains independent of compatibility packages, alternate-host identities and sibling-provider implementations. See [AGENTS.md](./AGENTS.md).

## Bug reports

Every bug issue must include:

- Clear **reproduction steps**: OpenCode version, plugin entrypoint, what you did, what you expected and what happened.
- Which **model and variant** were selected, and the actual routed backend/model when relevant.
- Provider debug logs from a reproduction with `DEVIN_PROVIDER_DEBUG=1` (optional `DEVIN_PROVIDER_DEBUG_FILE`; see [README.md](./README.md#environment-variables)).
- Relevant **host logs** from the same reproduction, plus provider version or tested commit and loaded build/entrypoint.

Prefer, but do not require, relevant excerpts from the session transcript that show the failure. For cache or conversation-reuse problems, follow [docs/cache-log-runbook.md](./docs/cache-log-runbook.md).

Redact tokens, API keys, session/device IDs, account information, private identities and local paths before sharing any evidence. Issues without reproduction steps, model details or relevant logs will be closed; for install/build failures before a model can run, state which evidence is unavailable and include the failing command and output.

## Development

```bash
bun install --frozen-lockfile
bun run build
bun run typecheck
bun test
bun run check:pricing
```

After rebuilding, restart the host and verify that it loads the intended provider entrypoint and fresh `dist/`. A nearby checkout or a successful compilation alone does not prove which build a running host uses.

Architecture and package-boundary rules: [AGENTS.md](./AGENTS.md). Install and operator documentation: [README.md](./README.md) and [OpenCode 2.0](./docs/opencode-2.md).

## Pull requests

We strive for exceptional quality and consistency. Keep at most **3 open PRs** per contributor at a time.

When opening one:

- Keep it small and focused on one problem.
- Explain the problem and fix in your own words; say how you verified it.
- For behavior changes, include **A/B testing results**: before versus after, OpenCode versions, entrypoints, models and variants tried, actual routing when relevant, and what improved or regressed. Distinguish unit/fixture tests from real provider sessions.
- **Preserve OpenCode's security, sandbox and permission model.** Canonical tool schemas, arguments, validation, execution and replay must remain consistent. Explain any change to authentication, tool execution, file access or approval behavior.
- Add meaningful regression coverage. Protocol changes need independent vendor-schema or captured-wire evidence and sanitized fixtures; testing an encoder against its own decoder is not independent proof.
- Preserve the provider/compatibility boundary across source, tests, package metadata, lockfile and built output. Run the post-build architecture checks and inspect `npm pack --dry-run --json --ignore-scripts` before claiming the package is ready.
- Link `Fixes #123` or `Closes #123` when applicable.
- Update [CHANGELOG.md](./CHANGELOG.md) under `## [Unreleased]` for user-facing changes. Keep README and the appropriate OpenCode guide accurate when behavior, configuration or limitations change.
- Prefer conventional-commit titles (`fix:`, `docs:`, `test:`). PR descriptions must be concise, concrete and written for people.
- **Bug fixes must not regress prompt caching or conversation continuity.** Verify warm reuse where expected using the [cache log runbook](./docs/cache-log-runbook.md). Identify the tested revision and report missing or unavailable cache metrics honestly.
- **Consider both OpenCode 1.x and OpenCode 2.0** for every fix. Apply or verify the change on both majors unless the issue is entrypoint-specific; explain any exclusion with evidence.
- Keep credentials and private data out of source, fixtures, logs, reports and commit metadata. Scan outgoing content before publication and use public GitHub noreply attribution.

Missing live access, skipped checks and registration-only startup are validation gaps. Do not report them as passing behavior checks. Compatibility-host acceptance belongs in OCP and does not authorize host-specific branches in this provider.

## License

Contributions are licensed under the [MIT License](./LICENSE). See also [DISCLAIMER.md](./DISCLAIMER.md).
