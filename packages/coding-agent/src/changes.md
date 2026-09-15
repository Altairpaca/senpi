# src

## 2026-09-16 - Export kernelTools storage (senpi#1647)

### What changed

- packages/coding-agent/src/index.ts exports kernelToolsStorage and ExtensionKernelTools for senpi-codemode.

### Why

- packages/coding-agent/src/index.ts is the public `@code-yeongyu/senpi` surface the originating eval uses to bind kernel tools onto host-tool context.

### Why an extension could not handle it

- Package index re-exports are owned by coding-agent; an extension cannot add a host context capability type.

### Expected merge conflict zones

- packages/coding-agent/src/index.ts adjacent to other extension exports.
