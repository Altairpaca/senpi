## 2026-10-03 - claude-agent-sdk 0.3.288 (senpi#2545)

### What changed

- `packages/coding-agent/package.json`: `@anthropic-ai/claude-agent-sdk` 0.3.286 -> 0.3.288 (Claude Code 2.1.286 -> 2.1.288). `bun.lock`, `package-lock.json` and `install-lock/package-lock.json` regenerated with `bun run refresh-lock`; the eight platform packages are relocked with `scripts/generate-claude-agent-sdk-platform-lock.mjs`.
- The engine's Claude Code fingerprint floor moves with it (`packages/ai/src/changes.md`), which regression #2033 requires.

### Why

- The nightly Releasability gate's `Claude Agent SDK currency` job fails while the pin trails npm latest (0.3.288).

### Why an extension could not handle it

- The pin and its locks are package metadata; no extension hook changes which SDK the package installs.

### Expected merge conflict zones

- LOW: the SDK pin line in `package.json` and the generated lock files (regenerate, never hand-merge).

