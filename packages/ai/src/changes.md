## 2026-10-03 - Claude Code fingerprint floor 2.1.288 (senpi#2545)

### What changed

- `packages/ai/src/api/anthropic-messages.ts`: the `claudeCodeVersion` floor declaration is 2.1.288, the Claude Code version `@anthropic-ai/claude-agent-sdk` 0.3.288 ships. The declaration keeps its literal `const claudeCodeVersion = "X.Y.Z";` form.

### Why

- Regression #2033 keeps the floor equal to the pinned SDK's `claudeCodeVersion`; the pin moved (`packages/coding-agent/changes.md`).

### Why an extension could not handle it

- The OAuth fingerprint is built inside the Anthropic API module before any extension hook.

### Expected merge conflict zones

- LOW: the `claudeCodeVersion` declaration line.

