import { AsyncLocalStorage } from "node:async_hooks";

export type ExtensionKernelTools = {
	describe(names: readonly string[]): Promise<unknown>;
	invoke(
		request: {
			name: string;
			kernel_generation: number;
			definition_revision: number;
			args: unknown;
			call_id: string;
		},
		signal?: AbortSignal,
	): Promise<unknown>;
};

export const kernelToolsStorage = new AsyncLocalStorage<ExtensionKernelTools>();
