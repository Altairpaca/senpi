import { describe, expect, it } from "vitest";
import {
	buildMcpToolName,
	MCP_TOOL_NAME_MAX_LENGTH,
} from "../../coding-agent/src/core/extensions/builtin/mcp/expose/naming.ts";
import { RESERVED_AGENT_TOOL, RESERVED_OUTPUT_TOOL, RESERVED_SCHEMA_TOOL } from "../src/bridge/reserved.ts";
import {
	MCP_TOOL_NAME_MAX_LENGTH as kernelMaxLength,
	kernelToolKey,
	sanitizeNamePart,
} from "../src/kernels/js/kernel-tools-naming.ts";
import { createKernelToolRegistry, createToolNamespace } from "../src/kernels/js/kernel-tools-registry.ts";
import { KERNEL_TOOLS_UNSUPPORTED } from "../src/kernels/js/kernel-tools-types.ts";

function lookup(path: string) {
	return path;
}

async function fetchText(url: string) {
	return url;
}

function registry(
	options: Parameters<typeof createKernelToolRegistry>[0] = {
		hostToolNames: ["read", "bash"],
		foreignLanguageNames: ["py_lookup"],
	},
) {
	return createKernelToolRegistry(options);
}

function expectCode(run: () => unknown, code: string): void {
	try {
		run();
		throw new Error(`expected ${code}`);
	} catch (error) {
		expect(error).toMatchObject({ code });
	}
}

describe("named functions expose fenced descriptors", () => {
	it("applies existing MCP naming rules and default JSON object schemas", () => {
		expect(kernelMaxLength).toBe(MCP_TOOL_NAME_MAX_LENGTH);
		expect(sanitizeNamePart("read.file")).toBe("read_file");
		expect(buildMcpToolName({ serverName: "read.file", toolName: "x" }).startsWith("mcp_read_file_")).toBe(true);
		expect(kernelToolKey("read-file")).toBe("read_file");
		const descriptor = registry().define(lookup);
		expect(descriptor).toEqual({
			name: "lookup",
			description: "",
			language: "js",
			kernel_generation: 1,
			definition_revision: 1,
			input_schema: {
				type: "object",
				properties: { path: {} },
				required: ["path"],
				additionalProperties: false,
			},
		});
	});

	it("invokes named async functions with JSON args in declared order", async () => {
		const seen: unknown[] = [];
		function pair(left: string, right: string) {
			seen.push(left, right);
			return `${left}:${right}`;
		}
		const tools = registry();
		const descriptor = tools.define(pair, {
			description: "join",
			schema: {
				type: "object",
				properties: { left: { type: "string" }, right: { type: "string" } },
				required: ["left", "right"],
				additionalProperties: false,
			},
		});
		expect(descriptor.description).toBe("join");
		const asyncDescriptor = tools.define(fetchText);
		expect(asyncDescriptor.name).toBe("fetchText");
		await expect(
			tools.invoke({
				name: "pair",
				kernel_generation: 1,
				definition_revision: 1,
				args: { right: "b", left: "a" },
				call_id: "c1",
			}),
		).resolves.toBe("a:b");
		expect(seen).toEqual(["a", "b"]);
	});

	it("describe returns only requested live names", () => {
		const tools = registry();
		tools.define(lookup);
		tools.define(fetchText);
		const described = tools.describe(["fetchText", "missing"]);
		expect(described.results.map((entry) => entry.name)).toEqual(["fetchText", "missing"]);
		expect(described.results[0]).toMatchObject({
			ok: true,
			descriptor: { name: "fetchText", kernel_generation: 1, definition_revision: 1, language: "js" },
		});
		expect(described.results[1]).toMatchObject({ ok: false, error: { code: "kernel_tool_missing" } });
	});

	it("keeps tool() callable while tool.read host calls still work", async () => {
		const host: Array<{ name: string; args: unknown }> = [];
		const tools = registry();
		const tool = createToolNamespace(
			(fn, metadata) => tools.define(fn, metadata),
			async (name, args) => {
				host.push({ name, args });
				return { text: String(name) };
			},
		);
		expect(typeof tool).toBe("function");
		const descriptor = tool(lookup);
		expect(descriptor).toMatchObject({ name: "lookup", language: "js" });
		await expect(tool.read({ path: "demo.txt" })).resolves.toEqual({ text: "read" });
		expect(host).toEqual([{ name: "read", args: { path: "demo.txt" } }]);
	});
});

describe("reserved collisions and stale descriptors fail closed", () => {
	it("rejects anonymous destructured default and rest parameters", () => {
		const tools = registry();
		expectCode(() => tools.define(() => 1), "invalid_tool_definition");
		expectCode(() => tools.define((path: string) => path), "invalid_tool_definition");
		expectCode(
			() =>
				tools.define(function wrapped({ path }: { path: string }) {
					return path;
				}),
			"invalid_tool_definition",
		);
		expectCode(
			() =>
				tools.define(function fallback(path = ".") {
					return path;
				}),
			"invalid_tool_definition",
		);
		expectCode(
			() =>
				tools.define(function rest(...path: string[]) {
					return path;
				}),
			"invalid_tool_definition",
		);
		expectCode(() => tools.define(lookup, { schema: () => ({}) }), "invalid_tool_definition");
	});

	it("rejects reserved names host collisions and cross-language names", () => {
		const tools = registry();
		expectCode(
			() =>
				tools.define(function read(path: string) {
					return path;
				}),
			"tool_name_collision",
		);
		expectCode(
			() =>
				tools.define(function py_lookup(path: string) {
					return path;
				}),
			"tool_name_collision",
		);
		expectCode(
			() =>
				tools.define(function __agent__() {
					return 1;
				}),
			"reserved_tool_name",
		);
		expectCode(
			() =>
				tools.define(function __output__() {
					return 1;
				}),
			"reserved_tool_name",
		);
		expectCode(
			() =>
				tools.define(function __schema__() {
					return 1;
				}),
			"reserved_tool_name",
		);
		expect([RESERVED_AGENT_TOOL, RESERVED_OUTPUT_TOOL, RESERVED_SCHEMA_TOOL]).toEqual([
			"__agent__",
			"__output__",
			"__schema__",
		]);
		const first = tools.define(lookup);
		const second = tools.define(lookup);
		expect(first.definition_revision).toBe(1);
		expect(second.definition_revision).toBe(2);
		expect(second.kernel_generation).toBe(1);
	});

	it("reset kill and redefinition make old descriptors stale", async () => {
		const tools = registry();
		const first = tools.define(lookup);
		const redefined = tools.define(lookup);
		await expect(
			tools.invoke({
				name: first.name,
				kernel_generation: first.kernel_generation,
				definition_revision: first.definition_revision,
				args: { path: "x" },
				call_id: "old-rev",
			}),
		).rejects.toMatchObject({ code: "kernel_tool_stale" });
		await expect(
			tools.invoke({
				name: redefined.name,
				kernel_generation: redefined.kernel_generation,
				definition_revision: redefined.definition_revision,
				args: { path: "x" },
				call_id: "live-rev",
			}),
		).resolves.toBe("x");
		const generation = tools.bumpGeneration();
		expect(generation).toBeGreaterThan(first.kernel_generation);
		await expect(
			tools.invoke({
				name: redefined.name,
				kernel_generation: redefined.kernel_generation,
				definition_revision: redefined.definition_revision,
				args: { path: "x" },
				call_id: "old-gen",
			}),
		).rejects.toMatchObject({ code: "kernel_tool_stale" });
		expect(tools.describe(["lookup"]).results[0]).toMatchObject({
			ok: false,
			error: { code: "kernel_tool_missing" },
		});
	});

	it("returns tools_unavailable for non-JS registries and unsupported hosts", () => {
		expect(KERNEL_TOOLS_UNSUPPORTED).toEqual({
			code: "tools_unavailable",
			message: "Kernel tools require a live JavaScript worker context",
		});
		expectCode(() => registry({ language: "py" }).define(lookup), "tools_unavailable");
		expectCode(() => registry({ language: "py" }).describe(["lookup"]), "tools_unavailable");
	});
});
