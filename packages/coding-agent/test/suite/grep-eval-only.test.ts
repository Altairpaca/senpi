import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "../../src/core/sdk.ts";
import { normalizeToolExposure } from "../../src/core/extensions/types.ts";
import { createHarness } from "./harness.ts";

vi.mock("@code-yeongyu/senpi", async () => await import("../../src/index.ts"));

const PROBE_HINT = 'tool.probe({ ... })';

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

interface ProbeHarnessOptions {
	withEval?: boolean;
	fileSettings?: boolean;
}

async function createProbeHarness(options: ProbeHarnessOptions = {}) {
	const extensionFactory: ExtensionFactory = (pi) => {
		if (options.withEval !== false) {
			pi.registerTool({
				name: "eval",
				label: "Eval",
				description: "Evaluate code",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "eval" }], details: {} }),
			});
		}
		pi.registerTool({
			name: "probe",
			label: "Probe",
			description: "Probe the system",
			exposure: "eval",
			parameters: Type.Object({ value: Type.String() }),
			execute: async (_id, params) => ({
				content: [{ type: "text", text: `probe-ran:${params.value}` }],
				details: {},
			}),
		});
	};
	return { harness: await createHarness({ extensionFactories: [extensionFactory], fileSettings: options.fileSettings }) };
}

describe("policy", () => {
	it("withholds an eval-exposed extension tool while eval is present, but executes it", async () => {
		const { harness } = await createProbeHarness();
		try {
			harness.session.setActiveToolsByName(["read", "eval", "probe", "edit", "write"]);
			expect(harness.session.getActiveToolNames()).not.toContain("probe");
			const result = await harness.session.executeTool("probe", { value: "ok" }, { activateInactiveTool: true });
			expect(textOf(result)).toContain("probe-ran:ok");
		} finally {
			harness.cleanup();
		}
	});

	it("keeps an eval-exposed extension tool directly callable without eval", async () => {
		const { harness } = await createProbeHarness({ withEval: false });
		try {
			harness.session.setActiveToolsByName(["read", "probe", "edit", "write"]);
			expect(harness.session.getActiveToolNames()).toContain("probe");
			const result = await harness.session.executeTool("probe", { value: "direct" });
			expect(textOf(result)).toContain("probe-ran:direct");
		} finally {
			harness.cleanup();
		}
	});

	it("publishes the eval redirect hint when armed", async () => {
		const { harness } = await createProbeHarness();
		try {
			harness.session.setActiveToolsByName(["read", "eval", "probe", "edit", "write"]);
			expect(harness.agent.removedToolHints.probe).toContain(PROBE_HINT);
		} finally {
			harness.cleanup();
		}
	});

	it("keeps eval exposure withheld after reload", async () => {
		const { harness } = await createProbeHarness({ fileSettings: true });
		try {
			harness.session.setActiveToolsByName(["read", "eval", "probe", "edit", "write"]);
			await harness.session.reload();
			expect(harness.session.getActiveToolNames()).not.toContain("probe");
		} finally {
			harness.cleanup();
		}
	});
});

describe("normalize", () => {
	it("passes eval exposure through and defaults lazy activation like direct tools", () => {
		expect(normalizeToolExposure({ exposure: "eval" })).toMatchObject({
			exposure: "eval",
			allowLazyActivation: true,
		});
	});
});
