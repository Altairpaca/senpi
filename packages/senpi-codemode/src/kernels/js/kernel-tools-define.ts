export type KernelToolFunction = {
	readonly name: string;
};

export function createToolNamespace(
	define: (fn: KernelToolFunction, metadata?: unknown) => unknown,
	callHost: (name: string, args: unknown) => Promise<unknown>,
): ((fn: KernelToolFunction, metadata?: unknown) => unknown) & {
	readonly [name: string]: (args?: unknown) => Promise<unknown>;
} {
	const registrar = function tool(fn: KernelToolFunction, metadata?: unknown) {
		return define(fn, metadata);
	};
	return new Proxy(registrar, {
		get(target, prop) {
			if (typeof prop !== "string") return undefined;
			if (prop in Function.prototype || prop === "arguments" || prop === "caller") {
				return (target as unknown as Record<string, unknown>)[prop];
			}
			return async (args?: unknown) => await callHost(prop, args ?? {});
		},
	}) as ((fn: KernelToolFunction, metadata?: unknown) => unknown) & {
		readonly [name: string]: (args?: unknown) => Promise<unknown>;
	};
}
