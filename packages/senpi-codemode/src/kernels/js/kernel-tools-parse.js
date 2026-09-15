import { parse } from "@babel/parser";
import { kernelToolError } from "./kernel-tools-errors.js";

const PARSE_OPTIONS = {
	sourceType: "script",
	allowAwaitOutsideFunction: true,
	plugins: ["typescript"],
};

export function parseToolFunction(fn) {
	if (typeof fn !== "function") throw kernelToolError("invalid_tool_definition", "tool() requires a named function");
	const source = fn.toString();
	if (source.includes("[native code]")) {
		throw kernelToolError("invalid_tool_definition", "tool() cannot wrap native functions");
	}
	const node = parseFunctionNode(source);
	if (!isNamedFunction(node)) throw kernelToolError("invalid_tool_definition", "tool() requires a named function");
	if (node.generator) throw kernelToolError("invalid_tool_definition", "tool() does not allow generator functions");
	const params = [];
	for (const param of node.params) {
		if (param.type !== "Identifier" || param.optional) {
			throw kernelToolError("invalid_tool_definition", "tool() requires simple identifier parameters");
		}
		params.push(param.name);
	}
	return { name: node.id.name, params, async: Boolean(node.async) };
}

function parseFunctionNode(source) {
	const direct = tryParse(source);
	if (direct) return direct;
	const wrapped = tryParse(`(${source})`);
	if (wrapped) return wrapped;
	throw kernelToolError("invalid_tool_definition", "tool() could not parse the function");
}

function tryParse(source) {
	try {
		const ast = parse(source, PARSE_OPTIONS);
		const stmt = ast.program.body[0];
		if (stmt?.type === "FunctionDeclaration") return stmt;
		if (stmt?.type === "ExpressionStatement") return stmt.expression;
		return undefined;
	} catch {
		return undefined;
	}
}

function isNamedFunction(node) {
	return (
		(node?.type === "FunctionDeclaration" || node?.type === "FunctionExpression") &&
		node.id?.type === "Identifier" &&
		typeof node.id.name === "string" &&
		node.id.name.length > 0
	);
}
