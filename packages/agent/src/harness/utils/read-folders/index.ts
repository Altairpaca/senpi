import { scanBraces } from "./brace-scanner.ts";
import type { ReadFolder, ReadFolderInput, ReadFolderResult, ReadFoldRange, ReadLineRange } from "./types.ts";

export * from "./types.ts";

/** Frozen row-17 selection, not a runtime registry that can enable unmeasured grammars. */
export const READ_FOLDER_SELECTION = Object.freeze({
	head: "0830b8c466e1f0689fa7f6f33cb7cfcd188b5407",
	selectionSha256: "b10b790182c83603cdc66f7e0d3b88464456ad49a45e621aea140d9c033f13a6",
	wasm: false,
	rawReasons: Object.freeze({ ts: "wasm_candidate_pending_owner", js: "wasm_candidate_pending_owner" } as const),
	languages: Object.freeze({
		ts: "raw",
		js: "raw",
		json: "heuristic",
		tsx: "unsupported",
		python: "unsupported",
		rust: "unsupported",
		go: "unsupported",
		markdown: "prose_exempt",
		txt: "prose_exempt",
	} as const),
} as const);

type Language = keyof typeof READ_FOLDER_SELECTION.languages;
function languageForPath(path: string): Language | undefined {
	const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
	if (!name.includes(".")) return undefined;
	switch (name.slice(name.lastIndexOf(".") + 1)) {
		case "ts":
			return "ts";
		case "js":
			return "js";
		case "json":
			return "json";
		case "tsx":
			return "tsx";
		case "py":
			return "python";
		case "rs":
			return "rust";
		case "go":
			return "go";
		case "md":
		case "markdown":
		case "mdown":
		case "mkd":
		case "mkdn":
			return "markdown";
		case "txt":
			return "txt";
		default:
			return undefined;
	}
}

/** Reader eligibility stays bound to the frozen selection even with a custom folder. */
export function isReadSummaryPath(path: string): boolean {
	const language = languageForPath(path);
	return language !== undefined && READ_FOLDER_SELECTION.languages[language] === "heuristic";
}

function hierarchy(ranges: readonly ReadLineRange[]): readonly ReadFoldRange[] | undefined {
	// Builder-owned arrays; no caller-owned ranges are sorted or mutated.
	type Node = ReadLineRange & { readonly children: Node[] };
	const roots: Node[] = [];
	const stack: Node[] = [];
	for (const range of [...ranges].sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine)) {
		while (stack.length && range.startLine > stack[stack.length - 1].endLine) stack.pop();
		const parent = stack[stack.length - 1];
		if (parent && range.startLine === parent.startLine && range.endLine === parent.endLine) continue;
		if (parent && (range.startLine <= parent.startLine || range.endLine >= parent.endLine)) return undefined;
		const node: Node = { ...range, children: [] };
		(parent ? parent.children : roots).push(node);
		stack.push(node);
	}
	return roots;
}

function fold({ path, text, settings }: ReadFolderInput): ReadFolderResult {
	const language = languageForPath(path);
	if (!language) return { status: "unsupported", reason: "unsupported_language" };
	const engine = READ_FOLDER_SELECTION.languages[language];
	switch (engine) {
		case "unsupported":
			return { status: "unsupported", reason: "unsupported_language" };
		case "prose_exempt":
			return { status: "unsupported", reason: "prose_exempt" };
		case "raw": // Retain the pure candidate for safety/quality measurement, never default-read eligibility.
		case "heuristic":
			break;
		default:
			return engine satisfies never;
	}
	// Narrow the language independently: the manifest is the sole enablement authority.
	if (language !== "ts" && language !== "js" && language !== "json")
		return { status: "unsupported", reason: "unsupported_language" };
	if (language === "json") {
		try {
			JSON.parse(text);
		} catch (error) {
			if (error instanceof SyntaxError) return { status: "parse_failure", reason: "invalid_json" };
			throw error;
		}
	}
	const scan = scanBraces(text, language, settings);
	switch (scan.status) {
		case "parse_failure":
			return scan;
		case "parsed": {
			const ranges = hierarchy(scan.ranges);
			return ranges
				? { status: "parsed", text, ranges }
				: { status: "parse_failure", reason: "ambiguous_line_boundaries" };
		}
		default:
			return scan satisfies never;
	}
}

export const selectedReadFolder: ReadFolder = Object.freeze({ id: "measured-brace", version: "3", fold });
