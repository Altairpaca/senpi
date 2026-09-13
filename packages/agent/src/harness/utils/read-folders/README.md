# Measured read folders

The agent package exports `selectedReadFolder`, `READ_FOLD_SETTINGS`,
`createSegmentedReadView` and `renderSegmentedReadView`. This is the row-18
library contract; built-in read execution does not consume it until row 19.

```ts
const parsed = selectedReadFolder.fold({ path, text, settings: READ_FOLD_SETTINGS });
const view = createSegmentedReadView({ text, parsed });
```

`ReadFolder` has immutable `id`/`version` and a synchronous pure `fold` method.
`parsed` binds the exact input text to hierarchical inclusive 1-based omitted
interiors. A stale text/result pair or invalid hierarchy yields `no_summary`.
`unsupported` includes an explicit `prose_exempt` reason; lexer ambiguity yields
`parse_failure`, never a partial list of plausible ranges. I/O and cancellation
are outside this synchronous contract; unexpected errors propagate.

The frozen row-17 selection at `d186dd4a7` enables only `.ts`, `.js` and `.json`.
Other extensions are unsupported; Markdown variants and `.txt` are prose-exempt.
There is no parser/grammar dependency, WASM initialization, global parse cache,
filesystem lookup, live language server or subprocess. The test-only row-17
prototype remains an unchanged measurement record.

The scanner preserves escaped quoted strings, templates and interpolation,
line/block comments, contextual regexes and balanced delimiters. Documentation
comments and binding/import/export members stay visible. Unknown tokens,
ambiguous regex/angle syntax, Unicode-set regex grammar, unclosed spans and
ambiguous line boundaries fall back conservatively. It is a lexical folder,
not a general TypeScript/JavaScript syntax validator.

Bodies require four interior lines; ordinary comments require six total lines.
Safe siblings fold independently, preserving each declaration's header and
closing line rather than eliding declarations as a combined run. A FIFO
frontier exposes outer ranges before their children until 50 source lines are
visible, never taking a step above 100. Oversized initial skeletons, unreachable
budgets, inputs below 100 lines and views without an output-byte saving return
`no_summary`. These five policy constants are internal, not user settings.

Only the shared segmented-view module validates/renders segments and builds the
footer. `kept` text equals exact LF-split source slices, including CR bytes,
trailing whitespace and terminal empty lines. `elided` contains coordinates
only. Rendering inserts an ellipsis on its own line and emits `{text,
elidedRanges,footer}`; `footer.rereads` contains `{offset,limit}` for every omitted
range. Synthetic lines are not editable source. No merged signature/closing
lines, numbered fold IDs or path-range selectors are created.
