# Measured read folders

Both built-in readers and ordinary session factories use the agent package's
`selectedReadFolder` through `createDefaultReadSummary`. Explicit offset/limit
requests, truncated input, prose and unselected languages retain the existing raw
read path. An explicitly supplied options object without a folder also stays raw.

The production-folder bake-off selects default summaries for `.js` and `.json`.
TypeScript remains raw with `wasm_candidate_pending_owner`: conservative scanner
improvements summarized four of five corpus files, but their 40.34% median saving
missed the required 47.28%. JS measured 44.32% and JSON 83.01%, above their respective
35.54% and 78.08% thresholds. `READ_FOLDER_SELECTION` binds the superseding
production measurement by commit and SHA-256. The historical row-17 prototype
results are not the shipping selection.

The pure TS candidate remains callable through `selectedReadFolder.fold` for
boundary tests and repeatable qualification measurements. This does not enable TS
summaries: default-read eligibility is separately and exclusively controlled by
`isReadSummaryPath`, including when a caller injects a custom folder. The bake-off
records the pure production candidate and actual selected default-read outputs
separately, and checks the latter against the frozen selection.

```ts
const parsed = selectedReadFolder.fold({ path, text, settings: READ_FOLD_SETTINGS });
const view = createSegmentedReadView({ text, parsed });
```

`ReadFolder` has immutable `id`/`version` and a synchronous pure `fold` method.
`parsed` binds exact input text to hierarchical inclusive 1-based omitted
interiors. A stale text/result pair or invalid hierarchy yields `no_summary`.
Unsupported extensions and prose are explicit outcomes; lexical ambiguity yields
`parse_failure`, never a partial list of plausible ranges. I/O and structured
cancellation stay outside this synchronous contract.

The lexer preserves quoted strings, templates/interpolation, comments, contextual
regexes and balanced delimiters. Binding/import/export members and parameter and
return-type signatures stay protected. Only proven expression calls release
argument values; untyped callback arguments can expose value bodies. Brace-free
balanced type arguments are skipped without folding. An unresolved angle context
reaching a brace, ambiguous comma binding, Unicode-set regex or unclosed literal
falls back raw. This is conservative lexical classification, not a partial
TypeScript syntax validator. No parser/grammar runtime, WASM, filesystem lookup,
language server, subprocess or memo is introduced.

Bodies require four interior lines; ordinary comments require six total lines.
Safe sibling bodies preserve separate header and closing lines. The sole pure
segmented-view module validates source coverage and refines a FIFO frontier until
50 source lines are visible, never taking a step above 100. Oversized skeletons,
unreachable budgets, inputs below 100 lines and views without an output-byte
saving return `no_summary`. These policy constants are internal, not settings.

Kept text equals exact LF-split source slices, including CR bytes, whitespace and
terminal empty lines. Elisions contain coordinates only; rendering inserts an
ellipsis on its own line and supplies numeric `offset`/`limit` rereads. Synthetic
lines are not edit anchors. There are no merged brace lines, numbered fold IDs or
path-range selectors. Markdown variants and `.txt` remain prose-exempt.
