import { kernelToolError } from "./kernel-tools-errors.js";

const IDENT = /^[A-Za-z_$][\w$]*$/;

export function parseToolFunction(fn) {
	if (typeof fn !== "function") throw kernelToolError("invalid_tool_definition", "tool() requires a named function");
	const source = fn.toString().trim();
	if (source.includes("[native code]")) {
		throw kernelToolError("invalid_tool_definition", "tool() cannot wrap native functions");
	}
	if (source.includes("=>") || source.startsWith("class ") || /^\*?function\s*\(/.test(source) || source.startsWith("function*")) {
		throw kernelToolError("invalid_tool_definition", "tool() requires a named function");
	}
	const match = /^(async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/u.exec(source);
	if (!match) throw kernelToolError("invalid_tool_definition", "tool() requires a named function");
	const params = parseParams(match[3]);
	return { name: match[2], params, async: Boolean(match[1]) };
}

function parseParams(raw) {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return [];
	if (/[={}\[\].:]/.test(trimmed)) {
		throw kernelToolError("invalid_tool_definition", "tool() requires simple identifier parameters");
	}
	const params = trimmed.split(",").map((part) => part.trim()).filter(Boolean);
	for (const name of params) {
		if (!IDENT.test(name)) throw kernelToolError("invalid_tool_definition", "tool() requires simple identifier parameters");
	}
	return params;
}
