export function createToolNamespace(
	define: (fn: Function, metadata?: unknown) => unknown,
	callHost: (name: string, args: unknown) => Promise<unknown>,
): ((fn: Function, metadata?: unknown) => unknown) & Record<string, (args?: unknown) => Promise<unknown>>;
