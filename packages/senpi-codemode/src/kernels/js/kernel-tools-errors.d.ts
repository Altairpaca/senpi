export const KERNEL_TOOL_ERROR_CODES: readonly [
	"tools_unavailable",
	"invalid_tool_definition",
	"reserved_tool_name",
	"tool_name_collision",
	"kernel_tool_stale",
	"kernel_tool_missing",
	"kernel_tool_failed",
	"kernel_tool_recursion",
];

export type KernelToolErrorCode = (typeof KERNEL_TOOL_ERROR_CODES)[number];

export class KernelToolError extends Error {
	readonly name: "KernelToolError";
	readonly code: KernelToolErrorCode;
	constructor(code: KernelToolErrorCode, message: string);
}

export function kernelToolError(code: KernelToolErrorCode, message: string): KernelToolError;
