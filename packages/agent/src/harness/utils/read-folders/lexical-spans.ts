type Span = { readonly end: number; readonly newlines: number };

// Selected TS/JS/JSON branches of row 17's measured literal scanner.
// Offsets are UTF-16 indices; output coordinates always describe whole source lines.
export function stringSpan(source: string, start: number, delimiter: string): Span | undefined {
	let newlines = 0;
	for (let i = start; i < source.length; i++) {
		if (source[i] === delimiter) return { end: i + 1, newlines };
		if (source[i] === "\n" || source[i] === "\r") return undefined;
		if (source[i] === "\\") {
			if (source[i + 1] === "\r" && source[i + 2] === "\n") i++;
			if (source[i + 1] === "\n") newlines++;
			i++;
		}
	}
	return undefined;
}

export function commentSpan(source: string, start: number): Span | undefined {
	let newlines = 0;
	for (let i = start; i < source.length; i++) {
		if (source[i] === "\n") newlines++;
		if (source.startsWith("*/", i)) return { end: i + 2, newlines };
	}
	return undefined;
}

export function regexSpan(source: string, start: number): Span | undefined {
	let characterClass = false;
	for (let i = start; i < source.length; i++) {
		if (source[i] === "\n" || source[i] === "\r" || source[i] === "\u2028" || source[i] === "\u2029")
			return undefined;
		if (source[i] === "\\") {
			if (/[\r\n\u2028\u2029]/.test(source[i + 1] ?? "")) return undefined;
			i++;
			continue;
		}
		if (source[i] === "[") characterClass = true;
		if (source[i] === "]") characterClass = false;
		if (source[i] === "/" && !characterClass) {
			let end = i + 1;
			while (/[a-z]/i.test(source[end] ?? "")) end++;
			const flags = source.slice(i + 1, end);
			// Unicode-set regexes need a different nested-class grammar; do not guess.
			if (/[^dgimsuy]/.test(flags) || new Set(flags).size !== flags.length) return undefined;
			return { end, newlines: 0 };
		}
	}
	return undefined;
}
