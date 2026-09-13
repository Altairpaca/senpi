# Read-summary bake-off (issue #1639)

These modules are test-only measurement adapters. They are not exported by the agent package or imported by production read tools. No WASM dependency or production folder is added.

## Experiment

- `corpus.ts` verifies the pinned repositories, frozen input manifest hash, deterministic path ordering, duplicate paths, source hashes, and size/line limits. The execution evidence's `prepare-corpus.py` inventories the pinned read-only checkouts and copies the first five eligible files per language into owned scratch. Inventory and exclusion reasons are retained in the manifest. Synthetic cases are separate.
- `reference.ts` executes the pinned omp **ReadTool**, with isolated default settings, in a separate process. It uses the reference's already-pinned `gpt-tokenizer@4.0.0`, `o200k_base`, for every output. This is exact tokenization, not a character estimator. The dependency never enters the senpi manifest.
- `oracle.ts` annotates source using the existing TypeScript compiler API, Python's AST, and Rust AST matches. It does not use candidate ranges or rendered omp output as truth. Rust shares its source parser with omp; this limitation is explicit in the evidence. Retained bytes and coordinates are checked separately.
- `heuristic.ts` is a conservative brace/indent prototype. Templates, ambiguous slash tokens, JSX, multiline Python strings, and other unsupported lexical forms fall back. It is intentionally not tuned after observing the corpus. A correctness failure disqualifies the entire language.
- `scorer.ts` applies the zero-invalid-boundary and 90%-of-reference median-saving rule. Positive total savings are mandatory. Missing reference/tokenizer makes evidence inconclusive. Insufficient corpus and unapproved WASM candidates remain per-language raw fallbacks.
- `binary-sizes.ts` compiles identical-wrapper raw and heuristic probes with the same flags. These are measured prototype binary deltas, not a claim about a shipped senpi binary. Production source/binary parity belongs to the later packaging task.

## Running

Use a healthy approved remote runner with execution-owned senpi and omp copies. Install existing dependencies with `HUSKY=0 bun install --ignore-scripts --frozen-lockfile`. The omp copy also needs its version-matched native comparator addon. Never install reference/native dependencies into senpi or a read-only reference root.

Set `OMP_BAKEOFF_INPUT` to the copied corpus directory, `OMP_BAKEOFF_CORPUS_SHA256` to the frozen input manifest hash, and `OMP_BAKEOFF_REFERENCE` to the execution-owned omp copy. Run from the senpi root:

```sh
bun --conditions=source scripts/qa/omp-item1.ts --case bakeoff --out "$E/selection.json"
bun --conditions=source scripts/qa/omp-item1.ts --case bakeoff-invalid --out "$E/failure.json"
```

The output directory contains corpus/source annotations, actual raw/omp/candidate outputs, source/output hash bindings, token counts, latency observations, per-language decisions, and prototype compile commands/sizes. Latencies have no pass/fail threshold. Registry-only grammar research is recorded separately in `grammar-pins.json`; it does not authorize acquisition or packaging.

Run the deterministic test target from `packages/agent`:

```sh
node ../../node_modules/vitest/vitest.mjs run --maxWorkers=2 --config vitest.harness.config.ts test/harness/read-summary-bakeoff.test.ts
```

The owner gate remains `OQ1_unresolved_defaults_used`. Go has insufficient corpus and remains raw pending owner-approved additional sources. Markdown and plain text remain raw regardless of reference output. Later implementation must consume the frozen selection rather than treat the evaluation defaults as packaging authorization.
