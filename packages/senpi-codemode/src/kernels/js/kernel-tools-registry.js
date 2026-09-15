import { createToolNamespace } from "./kernel-tools-define.js";
import { kernelToolError } from "./kernel-tools-errors.js";
import { kernelToolKey, normalizeKernelToolName } from "./kernel-tools-naming.js";
import { parseToolFunction } from "./kernel-tools-parse.js";
import { orderedArgs, resolveToolMetadata, validateInvokeArgs } from "./kernel-tools-schema.js";

export { createToolNamespace };

const DEFAULT_RESERVED = Object.freeze(["__agent__", "__output__", "__schema__"]);

export function createKernelToolRegistry(options = {}) {
	const language = options.language ?? "js";
	let generation = options.generation ?? 1;
	const reservedKeys = new Set((options.reservedNames ?? DEFAULT_RESERVED).map(kernelToolKey));
	const hostKeys = new Set((options.hostToolNames ?? []).map(kernelToolKey));
	const foreignKeys = new Set((options.foreignLanguageNames ?? []).map(kernelToolKey));
	const entries = new Map();

	function assertJs() {
		if (language !== "js") throw kernelToolError("tools_unavailable", "Kernel tools are JavaScript-only");
	}

	function descriptorFor(entry) {
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
		define(fn, metadata) {
			assertJs();
			const parsed = parseToolFunction(fn);
			const resolved = resolveToolMetadata(metadata, parsed.params);
			const normalizedName = normalizeKernelToolName(parsed.name);
			const key = kernelToolKey(parsed.name);
			if (reservedKeys.has(key)) throw kernelToolError("reserved_tool_name", `Kernel tool name is reserved: ${parsed.name}`);
			if (hostKeys.has(key) || foreignKeys.has(key)) {
				throw kernelToolError("tool_name_collision", `Kernel tool name collides: ${parsed.name}`);
			}
			const existing = entries.get(key);
			if (existing && existing.originalName !== parsed.name) {
				throw kernelToolError("tool_name_collision", `Kernel tool name collides: ${parsed.name}`);
			}
			const entry = {
				originalName: parsed.name,
				normalizedName,
				fn,
				params: parsed.params,
				description: resolved.description,
				input_schema: resolved.input_schema,
				revision: existing ? existing.revision + 1 : 1,
			};
			entries.set(key, entry);
			return descriptorFor(entry);
		},
		describe(names) {
			assertJs();
			return {
				results: names.map((name) => {
					const entry = entries.get(kernelToolKey(name));
					if (!entry) {
						return {
							name,
							ok: false,
							error: { code: "kernel_tool_missing", message: `Kernel tool is not defined: ${name}` },
						};
					}
					return { name, ok: true, descriptor: descriptorFor(entry) };
				}),
			};
		},
		async invoke(request, signal) {
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
			validateInvokeArgs(entry.input_schema, request.args);
			try {
				return await entry.fn(...orderedArgs(entry.params, request.args));
			} catch (error) {
				if (error instanceof Error && typeof error.code === "string") throw error;
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
