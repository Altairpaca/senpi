import type { AgentToolResult } from "@code-yeongyu/senpi";
import { defaultCodemodeSettings } from "../../src/config/settings.ts";
import { createCodemodeSessionManager } from "../../src/extension/session-manager.ts";
import { createInterpreterDetector, getInterpreterAvailability } from "../../src/interpreters/detect.ts";
import { createEvalTool } from "../../src/tool/eval-tool.ts";
import type { EvalLanguage, ExecuteTool } from "../../src/tool/types.ts";
import { fakeExtensionContext } from "../eval/fakes.ts";

export const languages = ["js", "py", "rb", "jl"] as const;
const settings = { ...defaultCodemodeSettings, languages: { js: true, py: true, rb: true, jl: true } };
export const availability = await getInterpreterAvailability(settings, createInterpreterDetector());
export const poolId = "wp_0123456789abcdef0123456789abcdef";
export const agentSpec = { category: "fixture", prompt: "Return keyed results", model: "fixture/model" };
export const items = [{ key: "a", input: { nested: [1, null, true], text: "st_deadbeef" } }];
export const record = { pool_id: poolId, status: "open", mode: "fresh", workers: [], items: [] };
export const receipt = { pool_id: poolId, item_ids: [{ key: "a", item_id: "wi_fedcba9876543210fedcba9876543210" }] };

export function hostResult(details: unknown): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: JSON.stringify(details) }], details };
}

export async function fixture(executeTool: ExecuteTool) {
	const manager = await createCodemodeSessionManager({
		sessionId: `workpool-test-${crypto.randomUUID()}`,
		cwd: process.cwd(),
		settings,
		availability,
		executeTool,
		complete: async () => {
			throw new Error("Provider calls are forbidden in workpool tests");
		},
	});
	const evalTool = createEvalTool({
		enabledLanguages: settings.languages,
		kernelManager: manager,
		executeTool,
		cellTimeoutSeconds: 30,
	});
	return {
		manager,
		run: async (language: EvalLanguage, code: string, reset = false) =>
			await evalTool.execute(
				`workpool-cell-${crypto.randomUUID()}`,
				{ language, code, reset, summary: "Verify workpool contract" },
				undefined,
				undefined,
				fakeExtensionContext(),
			),
	};
}
