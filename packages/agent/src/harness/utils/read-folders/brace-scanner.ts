import { commentSpan, regexSpan, stringSpan } from "./lexical-spans.ts";
import type { ReadFoldSettings, ReadLineRange } from "./types.ts";

type Scan =
	| { readonly status: "parsed"; readonly ranges: readonly ReadLineRange[] }
	| { readonly status: "parse_failure"; readonly reason: string };
type Open = {
	readonly char: "{" | "[" | "(";
	readonly line: number;
	readonly foldable: boolean;
	readonly protected: boolean;
	readonly interpolation: boolean;
	readonly control: boolean;
};
const expressionKeywords = new Set([
	"return",
	"throw",
	"yield",
	"await",
	"case",
	"typeof",
	"void",
	"delete",
	"in",
	"of",
	"instanceof",
]);
const controls = new Set(["if", "while", "for", "switch", "catch", "with"]);

/** Measured row-17 brace lexer, restricted to the three selected languages. */
export function scanBraces(source: string, language: "ts" | "js" | "json", settings: ReadFoldSettings): Scan {
	const ranges: ReadLineRange[] = [];
	const stack: Open[] = [];
	const fail = (reason: string): Scan => ({ status: "parse_failure", reason });
	let line = 1;
	let i = 0;
	let template = false;
	let templateDepth = 0;
	let previous = "";
	let expressionEnd: boolean | null = false;
	let importClause = false;
	if (source.startsWith("#!")) {
		const end = source.indexOf("\n");
		i = end < 0 ? source.length : end;
	}
	while (i < source.length) {
		const char = source[i];
		const next = source[i + 1];
		if (char === "\n") line++;
		if (template) {
			if (char === "\\") {
				if (next === "\n") line++;
				i += 2;
				continue;
			}
			if (char === "`") {
				template = false;
				templateDepth--;
				expressionEnd = true;
				previous = "literal";
			} else if (char === "$" && next === "{") {
				stack.push({ char: "{", line, foldable: false, protected: true, interpolation: true, control: false });
				template = false;
				expressionEnd = false;
				previous = "{";
				i += 2;
				continue;
			}
			i++;
			continue;
		}
		if (/\s/.test(char)) {
			i++;
			continue;
		}
		if (char === "/" && next === "/") {
			while (
				i < source.length &&
				source[i] !== "\n" &&
				source[i] !== "\r" &&
				source[i] !== "\u2028" &&
				source[i] !== "\u2029"
			)
				i++;
			continue;
		}
		if (char === "/" && next === "*") {
			const span = commentSpan(source, i + 2);
			if (!span) return fail("unterminated_comment");
			// Keep declaration docs and every delimiter line with the source signature.
			if (
				span.newlines + 1 >= settings.minCommentLines &&
				templateDepth === 0 &&
				!stack.some((open) => open.protected) &&
				!source.startsWith("/**", i) &&
				!source.startsWith("/*!", i)
			) {
				ranges.push({ startLine: line + 1, endLine: line + span.newlines - 1 });
			}
			line += span.newlines;
			i = span.end;
			continue;
		}
		if (char === '"' || char === "'") {
			const span = stringSpan(source, i + 1, char);
			if (!span) return fail("unterminated_string");
			line += span.newlines;
			i = span.end;
			previous = "literal";
			expressionEnd = true;
			if (!stack.length) importClause = false;
			continue;
		}
		if (char === "`") {
			template = true;
			templateDepth++;
			i++;
			continue;
		}
		if (char === "/") {
			if (expressionEnd === null) return fail("ambiguous_regex_literal");
			if (!expressionEnd) {
				const span = regexSpan(source, i + 1);
				if (!span) return fail("ambiguous_or_unterminated_regex");
				i = span.end;
				previous = "literal";
				expressionEnd = true;
				continue;
			}
			i += next === "=" ? 2 : 1;
			expressionEnd = false;
			previous = "/";
			continue;
		}
		if (/[A-Za-z_$]/.test(char)) {
			if (previous === "<") return fail("ambiguous_angle_syntax");
			const start = i++;
			while (/[A-Za-z_$0-9]/.test(source[i] ?? "")) i++;
			previous = source.slice(start, i);
			expressionEnd = !expressionKeywords.has(previous);
			if (previous === "import") importClause = true;
			if (previous === "from") importClause = false;
			continue;
		}
		if (/[0-9]/.test(char)) {
			i++;
			while (/[A-Za-z_0-9.]/.test(source[i] ?? "")) i++;
			expressionEnd = true;
			previous = "number";
			continue;
		}
		if (char === "{" || char === "[" || char === "(") {
			if (language !== "json" && char !== "(" && previous === ",") return fail("ambiguous_binding");
			// Parenthesized bindings/defaults and return-type literals are signature bytes.
			const protectedRange =
				char === "(" ||
				importClause ||
				stack.some((open) => open.protected) ||
				["const", "let", "var", "export", "type", "#", "!"].includes(previous) ||
				(language !== "json" && [":", "<", "&", "|"].includes(previous));
			const foldable =
				templateDepth === 0 &&
				char !== "(" &&
				!protectedRange &&
				(char === "{" || !expressionEnd || language === "json");
			stack.push({
				char,
				line,
				foldable,
				protected: protectedRange,
				interpolation: false,
				control: char === "(" && controls.has(previous),
			});
			expressionEnd = false;
			previous = char;
			i++;
			continue;
		}
		if (char === "}" || char === "]" || char === ")") {
			const open = stack.pop();
			if (!open || { "{": "}", "[": "]", "(": ")" }[open.char] !== char) return fail("unbalanced_delimiters");
			if (open.interpolation) {
				template = true;
				i++;
				continue;
			}
			if (open.foldable && line - open.line - 1 >= settings.minBodyLines)
				ranges.push({ startLine: open.line + 1, endLine: line - 1 });
			expressionEnd = open.control ? false : char === "}" ? null : true;
			if (char === "}") importClause = false;
			previous = char;
			i++;
			continue;
		}
		if ((char === "+" || char === "-") && next === char) {
			previous = char + char;
			i += 2;
			continue;
		}
		// JSX, escaped identifiers and unknown lexical tokens cannot establish safe delimiters.
		if (char === "<" && /^<\/?[A-Za-z][^\n]*>/.test(source.slice(i))) return fail("ambiguous_angle_syntax");
		if (!";:,.?=><!~+-*%&|^".includes(char)) return fail("unknown_token");
		if (char === ";") importClause = false;
		previous = char === "=" && next === ">" ? "=>" : char;
		i += previous === "=>" ? 2 : 1;
		expressionEnd = char === "." ? null : false;
	}
	return template || templateDepth || stack.length ? fail("unbalanced_delimiters") : { status: "parsed", ranges };
}
