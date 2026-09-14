import { languages } from "./corpus.ts";
import type { Prototype } from "./heuristic.ts";
import { type Fold, type Sample, selectEngine } from "./scorer.ts";

type ScoredRow = {
	readonly entry: {
		readonly id: string;
		readonly language: string;
		readonly file: string;
		readonly source: string;
		readonly sha256: string;
	};
	readonly candidate: Prototype;
	readonly allowed: readonly Fold[];
	readonly exact: boolean;
	readonly valid: boolean;
	readonly rawTokens: number;
	readonly ompTokens: number;
	readonly candidateTokens: number;
	readonly defaultReadTokens: number;
	readonly minimumOracleSkeleton: number;
};

export function selectLanguages(
	samples: readonly ScoredRow[],
	budget: number,
	adversarial: readonly { readonly id: string; readonly language: string; readonly valid: boolean }[] = [],
) {
	return languages.map((language) => {
		if (language === "markdown")
			return { language, engine: "raw", status: "prose_exempt", reason: "markdown_and_txt_remain_raw" };
		const real = samples.filter((row) => row.entry.language === language && !row.entry.id.startsWith("boundary-"));
		const invalid = [
			...samples.filter((row) => row.entry.language === language && !row.valid).map((row) => row.entry.id),
			...adversarial.filter((row) => row.language === language && !row.valid).map((row) => row.id),
		];
		const scored: Sample[] = real.map((row) => ({
			path: row.entry.file,
			source: row.entry.source,
			sha256: row.entry.sha256,
			folds: row.candidate.folds,
			allowed: row.allowed,
			retainedExact: row.exact,
			rawTokens: row.rawTokens,
			ompTokens: row.ompTokens,
			candidateTokens: row.candidateTokens,
		}));
		const result = selectEngine({
			samples: scored,
			referenceAvailable: true,
			tokenizerExact: true,
			embeddedBytes: 0,
			budget,
		});
		if (language === "go")
			return {
				language,
				...result,
				reason: "measurement_blocked_insufficient_corpus (2 tracked Go files, both <100 lines)",
				owner_action: "additional source corpus under OQ1",
				measured_files: 0,
			};
		return {
			language,
			...result,
			...(invalid.length ? { engine: "raw", status: "pending_owner", reason: "wasm_candidate_pending_owner" } : {}),
			measured_files: real.length,
			default_read_median_saving: real
				.map((row) => (row.rawTokens - row.defaultReadTokens) / row.rawTokens)
				.sort((a, b) => a - b)[2],
			default_read_saved_tokens: real.reduce((sum, row) => sum + row.rawTokens - row.defaultReadTokens, 0),
			files_with_folds: real.filter((row) => row.candidate.folds.length > 0).length,
			discovered_folds: real.reduce((sum, row) => sum + row.candidate.scanned_folds, 0),
			file_outcomes: real.map((row) => ({
				id: row.entry.id,
				emitted_folds: row.candidate.folds.length,
				fallback_reason: row.candidate.fallback_reason,
				minimum_oracle_skeleton_lines: row.minimumOracleSkeleton,
			})),
			invalid_boundaries: invalid,
			heuristic_rejection: invalid.length ? "invalid_boundaries" : result.reason,
			total_saved_tokens: real.reduce((sum, row) => sum + row.rawTokens - row.candidateTokens, 0),
		};
	});
}
