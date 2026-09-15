export const KERNEL_TOOL_ERROR_CODES = Object.freeze([
	"tools_unavailable",
	"invalid_tool_definition",
	"reserved_tool_name",
	"tool_name_collision",
	"kernel_tool_stale",
	"kernel_tool_missing",
	"kernel_tool_failed",
	"kernel_tool_recursion",
]);

export class KernelToolError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "KernelToolError";
		this.code = code;
	}
}

export function kernelToolError(code, message) {
	return new KernelToolError(code, message);
}
