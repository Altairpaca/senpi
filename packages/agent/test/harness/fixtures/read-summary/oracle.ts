import { execFileSync } from "node:child_process";
import * as ts from "@typescript/typescript6";
import { z } from "zod";
import type { Prototype } from "./heuristic.ts";
import type { SourceNode } from "./reference.ts";
import { type Fold, sha256 } from "./scorer.ts";

export type Annotation = Fold & {
	readonly kind: string;
	readonly startByte: number;
	readonly endByte: number;
	readonly header: string;
	readonly tail: string;
};

// Source oracle: compiler AST / Python ast / Rust AST matches, not candidate
// ranges and not ReadTool's rendered summary. Rust shares tree-sitter with omp;
// byte-boundary verification below remains independent of both renderers.
export function annotate(source: string, language: string, rustNodes: readonly SourceNode[] = []): Annotation[] {
	const ranges: (Fold & { kind: string })[] = [];
	const add = (start: number, end: number, kind: string) => {
		if (end >= start) ranges.push({ start, end, kind });
	};
	if (language === "python") {
		const script = `import ast,json,sys\ns=sys.stdin.read()\ntry:\n t=ast.parse(s)\nexcept SyntaxError:\n print('[]');sys.exit(0)\nr=[]\nfor n in ast.walk(t):\n if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and len(n.body):\n  r.append({'start':n.lineno+1,'end':n.end_lineno-1,'kind':'body'})\nprint(json.dumps(r))\n`;
		const result = execFileSync("python3", ["-c", script], { input: source, encoding: "utf8", timeout: 10000 });
		ranges.push(
			...z.array(z.object({ start: z.number(), end: z.number(), kind: z.string() })).parse(JSON.parse(result)),
		);
	} else if (language === "rust") {
		const bytes = Buffer.from(source);
		for (const node of rustNodes) {
			if (bytes.subarray(node.byteStart, node.byteEnd).toString("utf8") !== node.text)
				throw new Error("Rust AST source-byte mismatch");
			if (
				(node.text.startsWith("{") && node.text.endsWith("}")) ||
				(node.text.startsWith("[") && node.text.endsWith("]"))
			) {
				add(node.startLine + 1, node.endLine - 1, "body");
			}
			if (node.text.startsWith("/*") && node.text.endsWith("*/"))
				add(node.startLine + 1, node.endLine - 1, "comment");
		}
	} else if (["ts", "tsx", "js", "json"].includes(language)) {
		if (language === "json") {
			try {
				JSON.parse(source);
			} catch (error) {
				if (error instanceof SyntaxError) return [];
				throw error;
			}
		}
		const kind =
			language === "tsx"
				? ts.ScriptKind.TSX
				: language === "js"
					? ts.ScriptKind.JS
					: language === "json"
						? ts.ScriptKind.JSON
						: ts.ScriptKind.TS;
		const file = ts.createSourceFile(`input.${language}`, source, ts.ScriptTarget.Latest, true, kind);
		const line = (pos: number) => file.getLineAndCharacterOfPosition(pos).line + 1;
		const visit = (node: ts.Node) => {
			const children = node.getChildren(file);
			const open = children.find(
				(c) => c.kind === ts.SyntaxKind.OpenBraceToken || c.kind === ts.SyntaxKind.OpenBracketToken,
			);
			const close = children.findLast(
				(c) => c.kind === ts.SyntaxKind.CloseBraceToken || c.kind === ts.SyntaxKind.CloseBracketToken,
			);
			if (open && close && node.kind !== ts.SyntaxKind.NamedImports && node.kind !== ts.SyntaxKind.NamedExports)
				add(line(open.getStart(file)) + 1, line(close.getStart(file)) - 1, "body");
			node.forEachChild(visit);
		};
		visit(file);
		// Consecutive import declarations are a source-annotated sibling run.
		let imports: ts.Statement[] = [];
		const flushImports = () => {
			if (imports.length >= 3)
				add(line(imports[1].getStart(file)), line(imports[imports.length - 2].end - 1), "sibling");
			imports = [];
		};
		for (const statement of file.statements) {
			if (ts.isImportDeclaration(statement)) imports.push(statement);
			else flushImports();
		}
		flushImports();
		const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source);
		for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
			if (token === ts.SyntaxKind.MultiLineCommentTrivia)
				add(line(scanner.getTokenPos()) + 1, line(scanner.getTextPos() - 1) - 1, "comment");
		}
	}
	const lines = source.split("\n");
	return ranges
		.filter((r) => r.end >= r.start)
		.map((range) => ({
			...range,
			startByte: Buffer.byteLength(lines.slice(0, range.start - 1).join("\n")) + Number(range.start > 1),
			endByte: Buffer.byteLength(lines.slice(0, range.end).join("\n")),
			header: lines[range.start - 2] ?? "",
			tail: lines[range.end] ?? "",
		}));
}

export function retainedSourceExact(source: string, candidate: Prototype): boolean {
	if (!candidate.folds.length) return candidate.text === source;
	const lines = source.split("\n");
	const output = candidate.text.split("\n");
	let out = 0;
	for (let line = 1; line <= lines.length; line++) {
		const fold = candidate.folds.find((f) => f.start === line);
		if (fold) {
			if (output[out++] !== "…") return false;
			line = fold.end;
		} else if (output[out++] !== lines[line - 1]) return false;
	}
	const footer = output.slice(out).join("\n");
	const coordinates = [...footer.matchAll(/offset=(\d+) limit=(\d+)/g)].map((m) => ({
		start: Number(m[1]),
		end: Number(m[1]) + Number(m[2]) - 1,
	}));
	return JSON.stringify(coordinates) === JSON.stringify(candidate.folds);
}

export function compareOmp(source: string, output: string, allowed: readonly Fold[]) {
	const lines = source.split("\n");
	const retained = new Set<number>();
	const altered: number[] = [];
	const merged: Fold[] = [];
	for (const line of output.split("\n")) {
		const match = /^(\d+)(?:-(\d+))?:(.*)$/.exec(line);
		if (!match) continue;
		const start = Number(match[1]);
		const end = match[2] ? Number(match[2]) : start;
		retained.add(start);
		retained.add(end);
		if (start === end) {
			if (lines[start - 1] !== match[3]) altered.push(start);
		} else merged.push({ start, end }); // Omp deliberately synthesizes merged brace lines.
	}
	const gaps: Fold[] = [];
	let start = 0;
	const count = lines.length - Number(source.endsWith("\n"));
	for (let i = 1; i <= count + 1; i++) {
		if (i <= count && !retained.has(i)) {
			if (!start) start = i;
		} else if (start) {
			gaps.push({ start, end: i - 1 });
			start = 0;
		}
	}
	return {
		source_sha256: sha256(source),
		numberedLines: retained.size,
		alteredRetainedLines: altered,
		syntheticMergedLines: merged,
		gaps,
		unannotatedGaps: gaps.filter((g) => !allowed.some((a) => a.start === g.start && a.end === g.end)),
		note: "Unannotated reference gaps (including sibling folds) are not accepted as candidate ground truth.",
	};
}
