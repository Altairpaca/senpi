import type { KernelToolDescriptor, KernelToolsDescribeResult, KernelToolsInvokeRequest } from "./kernel-tools-types.ts";

export { createToolNamespace } from "./kernel-tools-define.js";

export type KernelToolRegistryOptions = {
	readonly generation?: number;
	readonly language?: "js" | "py" | "rb" | "jl";
	readonly hostToolNames?: readonly string[];
	readonly foreignLanguageNames?: readonly string[];
	readonly reservedNames?: readonly string[];
};

export type KernelToolRegistry = {
	readonly generation: number;
	define(fn: Function, metadata?: unknown): KernelToolDescriptor;
	describe(names: readonly string[]): KernelToolsDescribeResult;
	invoke(request: KernelToolsInvokeRequest, signal?: AbortSignal): Promise<unknown>;
	bumpGeneration(): number;
};

export function createKernelToolRegistry(options?: KernelToolRegistryOptions): KernelToolRegistry;
