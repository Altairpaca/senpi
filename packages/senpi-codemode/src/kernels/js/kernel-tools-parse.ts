import { type ParserOptions, parse } from "@babel/parser";
import { kernelToolError } from "./kernel-tools-errors.ts";

const PARSE_OPTIONS: ParserOptions = {
	sourceType: "script",
	allowAwaitOutsideFunction: true,
	plugins: ["typescript"],
};

type ParsedFunction = {
	readonly name: string;
	readonly params: readonly string[];
	readonly async: boolean;
};

export function parseToolFunction(fn: unknown): ParsedFunction {
	if (typeof fn !== "function") throw kernelToolError("invalid_tool_definition", "tool() requires a named function");
	const source = fn.toString();
	if (source.includes("[native code]")) {
		throw kernelToolError("invalid_tool_definition", "tool() cannot wrap native functions");
	}
	const node = parseFunctionNode(source);
	if (!isNamedFunction(node)) throw kernelToolError("invalid_tool_definition", "tool() requires a named function");
	if (node.generator) throw kernelToolError("invalid_tool_definition", "tool() does not allow generator functions");
	const params: string[] = [];
	for (const param of node.params) {
		if (param.type !== "Identifier" || ("optional" in param && param.optional)) {
			throw kernelToolError("invalid_tool_definition", "tool() requires simple identifier parameters");
		}
		if (typeof param.name !== "string") {
			throw kernelToolError("invalid_tool_definition", "tool() requires simple identifier parameters");
		}
		params.push(param.name);
	}
	return { name: node.id.name, params, async: Boolean(node.async) };
}

type FunctionNode = {
	readonly type: string;
	readonly generator?: boolean;
	readonly async?: boolean;
	readonly id?: { readonly type: string; readonly name: string };
	readonly params: ReadonlyArray<{ readonly type: string; readonly name?: string; readonly optional?: boolean }>;
};

function parseFunctionNode(source: string): FunctionNode {
	const direct = tryParse(source);
	if (direct) return direct;
	const wrapped = tryParse(`(${source})`);
	if (wrapped) return wrapped;
	throw kernelToolError("invalid_tool_definition", "tool() could not parse the function");
}

function tryParse(source: string): FunctionNode | undefined {
	try {
		const ast = parse(source, PARSE_OPTIONS);
		const stmt = ast.program.body[0];
		if (stmt?.type === "FunctionDeclaration") return stmt as unknown as FunctionNode;
		if (stmt?.type === "ExpressionStatement") return stmt.expression as unknown as FunctionNode;
		return undefined;
	} catch {
		return undefined;
	}
}

function isNamedFunction(
	node: FunctionNode,
): node is FunctionNode & { readonly id: { readonly type: "Identifier"; readonly name: string } } {
	return (
		(node.type === "FunctionDeclaration" || node.type === "FunctionExpression") &&
		node.id?.type === "Identifier" &&
		typeof node.id.name === "string" &&
		node.id.name.length > 0
	);
}
