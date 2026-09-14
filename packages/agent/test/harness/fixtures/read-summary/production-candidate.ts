import assert from "node:assert/strict";
import { createReadTool } from "../../../../../coding-agent/src/core/tools/read.ts";
import {
	isReadSummaryPath,
	READ_FOLD_SETTINGS,
	selectedReadFolder,
} from "../../../../src/harness/utils/read-folders/index.ts";
import { createSegmentedReadView } from "../../../../src/harness/utils/segmented-read-view.ts";
import type { Prototype } from "./heuristic.ts";
import type { Fold } from "./scorer.ts";

/** Measure the shipping folder/view and check it against the actual default read tool. */
export async function productionCandidate(
	cwd: string,
	path: string,
	source: string,
): Promise<Prototype & { readonly defaultReadText: string; readonly discoveredFolds: readonly Fold[] }> {
	const parsed = selectedReadFolder.fold({ path, text: source, settings: READ_FOLD_SETTINGS });
	const view = createSegmentedReadView({ text: source, parsed });
	const result = await createReadTool(cwd).execute("production-candidate", { path });
	const text = result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	const queue = parsed.status === "parsed" ? [...parsed.ranges] : [];
	for (let i = 0; i < queue.length; i++) queue.push(...queue[i].children);
	const discoveredFolds = queue.map((range) => ({ start: range.startLine, end: range.endLine }));
	switch (view.status) {
		case "summary":
			assert.equal(
				text,
				isReadSummaryPath(path) ? view.rendered.text : source,
				"Production read violates its frozen selection",
			);
			return {
				discoveredFolds,
				text: view.rendered.text,
				defaultReadText: text,
				folds: view.rendered.elidedRanges.map((range) => ({ start: range.startLine, end: range.endLine })),
				reason: "folded",
				scanned_folds: queue.length,
			};
		case "no_summary": {
			assert.equal(text, source, "Production raw fallback changed source bytes");
			const reason = parsed.status === "parse_failure" ? parsed.reason : view.reason;
			return {
				discoveredFolds,
				text,
				defaultReadText: text,
				folds: [],
				reason,
				fallback_reason: reason,
				scanned_folds: queue.length,
			};
		}
		default:
			return view satisfies never;
	}
}
