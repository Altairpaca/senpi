export const MCP_TOOL_NAME_MAX_LENGTH: 64;
export function sanitizeNamePart(name: string): string;
export function matcherKey(name: string): string;
export function ellipsizeMiddle(value: string, maxLength: number): string;
export function normalizeKernelToolName(name: string): string;
export function kernelToolKey(name: string): string;
