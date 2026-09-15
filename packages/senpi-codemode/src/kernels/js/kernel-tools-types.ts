import type { KernelToolErrorCode } from "./kernel-tools-errors.js";

export type { KernelToolErrorCode };

export type KernelToolDescriptor = {
	readonly name: string;
	readonly description: string;
	readonly input_schema: Readonly<Record<string, unknown>>;
	readonly language: "js";
	readonly kernel_generation: number;
	readonly definition_revision: number;
};

export type KernelToolsInvokeRequest = {
	readonly name: string;
	readonly kernel_generation: number;
	readonly definition_revision: number;
	readonly args: unknown;
	readonly call_id: string;
};

export type KernelToolsDescribeEntry =
	| { readonly name: string; readonly ok: true; readonly descriptor: KernelToolDescriptor }
	| { readonly name: string; readonly ok: false; readonly error: { readonly code: KernelToolErrorCode; readonly message: string } };

export type KernelToolsDescribeResult = {
	readonly results: readonly KernelToolsDescribeEntry[];
};

export type KernelToolsCapability = {
	describe(names: readonly string[]): Promise<KernelToolsDescribeResult>;
	invoke(request: KernelToolsInvokeRequest, signal?: AbortSignal): Promise<unknown>;
};

export const KERNEL_TOOLS_UNSUPPORTED = {
	code: "tools_unavailable" as const,
	message: "Kernel tools require a live JavaScript worker context",
};
