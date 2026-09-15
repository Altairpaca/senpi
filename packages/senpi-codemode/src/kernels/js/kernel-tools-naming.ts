/** MCP name rules from coding-agent mcp/expose/naming.ts, applied explicitly for kernel tools. */
export const MCP_TOOL_NAME_MAX_LENGTH = 64;

export function sanitizeNamePart(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function matcherKey(name: string): string {
	return name.replace(/-/g, "_");
}

export function ellipsizeMiddle(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	if (maxLength <= 3) return value.slice(0, maxLength);
	const marker = "...";
	const remaining = maxLength - marker.length;
	const prefixLength = Math.ceil(remaining / 2);
	const suffixLength = Math.floor(remaining / 2);
	return `${value.slice(0, prefixLength)}${marker}${value.slice(value.length - suffixLength)}`;
}

export function normalizeKernelToolName(name: string): string {
	return ellipsizeMiddle(sanitizeNamePart(name), MCP_TOOL_NAME_MAX_LENGTH);
}

export function kernelToolKey(name: string): string {
	return matcherKey(normalizeKernelToolName(name));
}
