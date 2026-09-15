export const kernelToolCallContext: {
	run<T>(store: KernelToolCallStore, fn: () => T): T;
	getStore(): KernelToolCallStore | undefined;
};

export type KernelToolCallStore = {
	readonly pendingTools: Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>;
	readonly callId: string;
	readonly generation: number;
	readonly signal: AbortSignal;
};

export function inKernelToolInvoke(): boolean;
