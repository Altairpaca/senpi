import type { ReadLineRange } from "./types.ts";

type Header = { readonly kind: "class" | "function"; readonly depth: number; readonly startLine: number };

/** A lexical proof only: ambiguous headers invalidate the whole parse, not just one fold. */
export class HeaderProtection {
	readonly intervals: ReadLineRange[] = [];
	private pending: Header | undefined;
	private parameters: { readonly depth: number; readonly startLine: number } | undefined;

	get active(): boolean { return this.pending !== undefined; }
	get unfinished(): boolean { return this.pending !== undefined; }

	word(word: string, previous: string, depth: number, line: number, typescript: boolean): boolean {
		// These operators can hide an arbitrarily shaped type before a real body.
		// No TypeScript grammar is installed: do not infer a boundary from the next brace.
		if (typescript && ["keyof", "typeof", "infer", "readonly", "satisfies", "as"].includes(word)) return false;
		if ((word === "class" || word === "function") && previous !== ".") {
			if (this.pending) return false; // e.g. a nested class expression in heritage
			this.pending = { kind: word, depth, startLine: line };
		}
		return true;
	}

	open(char: string, depth: number, previous: string, line: number): "class" | "function" | undefined {
		const header = this.pending;
		if (char !== "{" || header?.depth !== depth) return undefined;
		if (header.kind === "function" && previous !== ")") return undefined;
		this.protect(header.startLine, line);
		this.pending = undefined;
		this.parameters = undefined;
		return header.kind;
	}

	closedParameters(depth: number, startLine: number): void {
		this.parameters = { depth, startLine };
	}

	punctuation(token: string, depth: number, line: number): boolean {
		if (token === ":" && this.parameters?.depth === depth) return false;
		if ((token === "{" || token === "=>") && this.parameters?.depth === depth) {
			this.protect(this.parameters.startLine, line);
			this.parameters = undefined;
		} else if (token === ";" || token === "=" || token === ",") this.parameters = undefined;
		return true;
	}

	protect(startLine: number, endLine: number): void {
		this.intervals.push({ startLine, endLine });
	}

	filter(ranges: readonly ReadLineRange[]): ReadLineRange[] {
		return ranges.filter((range) => !this.intervals.some((header) =>
			range.startLine <= header.endLine && range.endLine >= header.startLine));
	}
}
