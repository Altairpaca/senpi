import { createToolNamespace, type KernelToolFunction } from "./kernel-tools-define.ts";
import { kernelToolError } from "./kernel-tools-errors.ts";
import { kernelToolKey, normalizeKernelToolName } from "./kernel-tools-naming.ts";
import { parseToolFunction } from "./kernel-tools-parse.ts";
import { orderedArgs, resolveToolMetadata, validateInvokeArgs } from "./kernel-tools-schema.ts";
import type {
	KernelToolDescriptor,
	KernelToolsDescribeResult,
	KernelToolsInvokeRequest,
} from "./kernel-tools-types.ts";

export { createToolNamespace };

const DEFAULT_RESERVED = ["__agent__", "__output__", "__schema__"] as const;

export type KernelToolRegistryOptions = {
	readonly generation?: number;
	readonly language?: "js" | "py" | "rb" | "jl";
	readonly hostToolNames?: readonly string[];
	readonly foreignLanguageNames?: readonly string[];
	readonly reservedNames?: readonly string[];
};

type RegistryEntry = {
	readonly originalName: string;
	readonly normalizedName: string;
	readonly fn: KernelToolFunction & ((...args: unknown[]) => unknown);
	readonly params: readonly string[];
	readonly description: string;
	readonly input_schema: KernelToolDescriptor["input_schema"];
	readonly revision: number;
};

export function createKernelToolRegistry(options: KernelToolRegistryOptions = {}) {
	const language = options.language ?? "js";
	let generation = options.generation ?? 1;
	const reservedKeys = new Set((options.reservedNames ?? DEFAULT_RESERVED).map(kernelToolKey));
	const hostKeys = new Set((options.hostToolNames ?? []).map(kernelToolKey));
	const foreignKeys = new Set((options.foreignLanguageNames ?? []).map(kernelToolKey));
	const entries = new Map<string, RegistryEntry>();

	function assertJs(): void {
		if (language !== "js") throw kernelToolError("tools_unavailable", "Kernel tools are JavaScript-only");
	}

	function descriptorFor(entry: RegistryEntry): KernelToolDescriptor {
		return {
			name: entry.normalizedName,
			description: entry.description,
			input_schema: entry.input_schema,
			language: "js",
			kernel_generation: generation,
			definition_revision: entry.revision,
		};
	}

	return {
		get generation() {
			return generation;
		},
		define(fn: KernelToolFunction, metadata?: unknown): KernelToolDescriptor {
			assertJs();
			const parsed = parseToolFunction(fn);
			const resolved = resolveToolMetadata(metadata, parsed.params);
			const normalizedName = normalizeKernelToolName(parsed.name);
			const key = kernelToolKey(parsed.name);
			if (reservedKeys.has(key))
				throw kernelToolError("reserved_tool_name", `Kernel tool name is reserved: ${parsed.name}`);
			if (hostKeys.has(key) || foreignKeys.has(key)) {
				throw kernelToolError("tool_name_collision", `Kernel tool name collides: ${parsed.name}`);
			}
			const existing = entries.get(key);
			if (existing && existing.originalName !== parsed.name) {
				throw kernelToolError("tool_name_collision", `Kernel tool name collides: ${parsed.name}`);
			}
			const entry: RegistryEntry = {
				originalName: parsed.name,
				normalizedName,
				fn: fn as RegistryEntry["fn"],
				params: parsed.params,
				description: resolved.description,
				input_schema: resolved.input_schema,
				revision: existing ? existing.revision + 1 : 1,
			};
			entries.set(key, entry);
			return descriptorFor(entry);
		},
		describe(names: readonly string[]): KernelToolsDescribeResult {
			assertJs();
			return {
				results: names.map((name) => {
					const entry = entries.get(kernelToolKey(name));
					if (!entry) {
						return {
							name,
							ok: false as const,
							error: { code: "kernel_tool_missing" as const, message: `Kernel tool is not defined: ${name}` },
						};
					}
					return { name, ok: true as const, descriptor: descriptorFor(entry) };
				}),
			};
		},
		async invoke(request: KernelToolsInvokeRequest, signal?: AbortSignal): Promise<unknown> {
			assertJs();
			if (signal?.aborted) {
				throw signal.reason ?? kernelToolError("kernel_tool_failed", "Kernel tool call aborted");
			}
			if (request.kernel_generation !== generation) {
				throw kernelToolError("kernel_tool_stale", "Kernel tool descriptor generation is stale");
			}
			const entry = entries.get(kernelToolKey(request.name));
			if (!entry) throw kernelToolError("kernel_tool_missing", `Kernel tool is not defined: ${request.name}`);
			if (entry.revision !== request.definition_revision) {
				throw kernelToolError("kernel_tool_stale", "Kernel tool descriptor revision is stale");
			}
			validateInvokeArgs(entry.input_schema as Parameters<typeof validateInvokeArgs>[0], request.args);
			try {
				const value = await entry.fn(...orderedArgs(entry.params, request.args));
				const live = entries.get(kernelToolKey(request.name));
				if (request.kernel_generation !== generation || live !== entry) {
					throw kernelToolError("kernel_tool_stale", "Kernel tool descriptor is stale");
				}
				return value;
			} catch (error) {
				if (error instanceof Error && "code" in error && typeof error.code === "string") throw error;
				throw kernelToolError("kernel_tool_failed", error instanceof Error ? error.message : String(error));
			}
		},
		bumpGeneration() {
			generation += 1;
			entries.clear();
			return generation;
		},
	};
}
