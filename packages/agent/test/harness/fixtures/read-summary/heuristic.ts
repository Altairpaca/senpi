import type { Fold } from "./scorer.ts";

export type Prototype = { readonly text: string; readonly folds: readonly Fold[]; readonly reason: string };

// Evaluation only. Ambiguous lexical constructs fall back instead of guessing.
function braceRanges(source: string): Fold[] | undefined {
	const ranges: Fold[] = [];
	const stack: { char: string; line: number }[] = [];
	let line = 1;
	let quote = "";
	let blockStart = 0;
	let lineComment = false;
	for (let i = 0; i < source.length; i++) {
		const char = source[i];
		const next = source[i + 1];
		if (char === "\n") {
			line++;
			lineComment = false;
		}
		if (lineComment) continue;
		if (blockStart) {
			if (char === "/" && next === "*") return undefined; // Rust nested comments need a parser.
			if (char === "*" && next === "/") {
				if (line - blockStart >= 5) ranges.push({ start: blockStart + 1, end: line - 1 });
				blockStart = 0;
				i++;
			}
			continue;
		}
		if (quote) {
			if (char === "\\") {
				i++;
				continue;
			}
			if (char === quote) quote = "";
			else if (char === "\n") return undefined;
			continue;
		}
		if (char === "`") return undefined;
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === "/") {
			if (next === "/") {
				lineComment = true;
				i++;
				continue;
			}
			if (next === "*") {
				blockStart = line;
				i++;
				continue;
			}
			return undefined; // Division versus regexp is intentionally unsupported.
		}
		if (char === "{" || char === "[") stack.push({ char, line });
		if (char === "}" || char === "]") {
			const open = stack.pop();
			if (!open || (open.char === "{" ? char !== "}" : char !== "]")) return undefined;
			if (line - open.line - 1 >= 4) ranges.push({ start: open.line + 1, end: line - 1 });
		}
	}
	return quote || blockStart || stack.length ? undefined : ranges;
}

function indentRanges(source: string): Fold[] | undefined {
	if (/\t|'''|"""|\\\n/.test(source)) return undefined;
	const lines = source.split("\n");
	const ranges: Fold[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (!/^\s*(?:async )?def \w+\([^#]*\)(?: -> [^:]+)?:\s*$/.test(lines[i])) continue;
		const indent = lines[i].length - lines[i].trimStart().length;
		let end = i + 1;
		while (end < lines.length && (!lines[end].trim() || lines[end].length - lines[end].trimStart().length > indent))
			end++;
		while (end > i + 1 && !lines[end - 1].trim()) end--;
		if (end - i - 2 >= 4) ranges.push({ start: i + 2, end: end - 1 });
	}
	return ranges;
}

export function renderPrototype(source: string, folds: readonly Fold[]): string {
	const lines = source.split("\n");
	const parts: string[] = [];
	let cursor = 0;
	for (const fold of folds) {
		parts.push(...lines.slice(cursor, fold.start - 1), "…");
		cursor = fold.end;
	}
	parts.push(...lines.slice(cursor));
	if (folds.length)
		parts.push(
			"",
			`[Elided source: ${folds.map((f) => `offset=${f.start} limit=${f.end - f.start + 1}`).join("; ")}]`,
		);
	return parts.join("\n");
}

export function heuristic(source: string, language: string): Prototype {
	const raw = (reason: string): Prototype => ({ text: source, folds: [], reason });
	const lines = source.split("\n");
	if (language === "markdown" || language === "txt") return raw("prose_exempt");
	if (lines.length < 100 || lines.length > 2000 || Buffer.byteLength(source) > 51200) return raw("size_gate");
	if (language === "tsx" && /<\/?[A-Za-z]/.test(source)) return raw("jsx_requires_parser");
	if (language === "json") {
		try {
			JSON.parse(source);
		} catch (error) {
			if (error instanceof SyntaxError) return raw("parse_failure");
			throw error;
		}
	}
	const ranges = language === "python" ? indentRanges(source) : braceRanges(source);
	if (!ranges) return raw("ambiguous_lexing");
	const ordered = ranges.sort((a, b) => a.start - b.start || b.end - a.end);
	let selected = ordered.filter(
		(range, i) => !ordered.slice(0, i).some((parent) => parent.start <= range.start && parent.end >= range.end),
	);
	const visible = (folds: readonly Fold[]) => lines.length - folds.reduce((n, f) => n + f.end - f.start + 1, 0);
	while (visible(selected) < 50) {
		let refined = false;
		for (const parent of selected) {
			const children = ordered.filter((r) => r.start > parent.start && r.end < parent.end);
			const direct = children.filter(
				(r, i) => !children.slice(0, i).some((p) => p.start <= r.start && p.end >= r.end),
			);
			const next = selected
				.filter((r) => r !== parent)
				.concat(direct)
				.sort((a, b) => a.start - b.start);
			if (visible(next) <= 100) {
				selected = next;
				refined = true;
				break;
			}
		}
		if (!refined) return raw("visible_budget_unreachable");
	}
	if (!selected.length || visible(selected) > 100) return raw("skeleton_exceeds_budget");
	const text = renderPrototype(source, selected);
	return text.length < source.length ? { text, folds: selected, reason: "folded" } : raw("no_byte_saving");
}
