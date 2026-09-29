import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import serviceTierExtension from "../../src/core/extensions/builtin/service-tier.ts";
import { parseModelPattern, resolveModelScopeFromModels } from "../../src/core/model-resolver.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const PROVIDER = "chatgpt-subscription";
const MODEL = "gpt-6-astra";
const astra = getModel(PROVIDER, MODEL);

describe("Ultrafast service-tier selection", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.restoreAllMocks();
	});

	it.each(EFFORTS)("parses %s effort with ultrafast in either decorator order and a glob", (effort) => {
		for (const suffix of [`${effort}:ultrafast`, `ultrafast:${effort}`]) {
			const resolved = parseModelPattern(`${PROVIDER}/${MODEL}:${suffix}`, [astra]);
			expect(resolved).toMatchObject({ model: astra, thinkingLevel: effort, serviceTier: "ultrafast" });
			expect(resolved.warning).toBeUndefined();
		}
		const scope = resolveModelScopeFromModels([`${PROVIDER}/gpt-6-*:${effort}:ultrafast`], [astra]);
		expect(scope.diagnostics).toEqual([]);
		expect(scope.scopedModels).toEqual([
			expect.objectContaining({ thinkingLevel: effort, serviceTier: "ultrafast" }),
		]);
	});

	it("accepts a models.json Ultrafast alias without losing its upstream id or effort map", async () => {
		const harness = await createHarness({
			modelsJson: {
				providers: {
					[PROVIDER]: {
						models: [{ ...astra, id: `${MODEL}-ultrafast`, upstreamModelId: MODEL, serviceTier: "ultrafast" }],
					},
				},
			},
		});
		harnesses.push(harness);
		expect(harness.modelRegistry.getError()).toBeUndefined();
		const model = harness.modelRegistry.find(PROVIDER, `${MODEL}-ultrafast`)!;
		expect(model).toBeDefined();
		expect(harness.modelRegistry.getUpstreamModelId(model)).toBe(MODEL);
		expect(harness.modelRegistry.getServiceTier(model)).toBe("ultrafast");
		for (const effort of EFFORTS) expect(model.thinkingLevelMap?.[effort]).toBe(effort);
	});

	it("round-trips ultrafast through global settings and model memory", async () => {
		const manager = SettingsManager.inMemory({ openai: { serviceTier: "ultrafast" } });
		expect(manager.getOpenAIServiceTier()).toBe("ultrafast");
		manager.setModelServiceTier(PROVIDER, MODEL, "ultrafast");
		await manager.flush();
		expect(manager.getModelServiceTier(PROVIDER, MODEL)).toBe("ultrafast");
	});

	it("keeps an Ultrafast model pin above remembered priority and the /fast toggle", async () => {
		const harness = await createHarness({
			api: "openai-codex-responses",
			provider: PROVIDER,
			models: [{ id: MODEL }],
			serviceTier: "ultrafast",
			fileSettings: true,
			settings: { modelServiceTiers: { [`${PROVIDER}/${MODEL}`]: "priority" } },
			extensionFactories: [serviceTierExtension],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const runner = harness.getExtensionRunner();
		const notify = vi.spyOn(runner.getUIContext(), "notify");
		for (const command of [undefined, "/fast on", "/fast off"]) {
			if (command) await harness.session.prompt(command);
			expect(harness.session.effectiveServiceTier).toBe("ultrafast");
			expect(await runner.emitBeforeProviderRequest({ model: MODEL })).toEqual({
				model: MODEL,
				service_tier: "ultrafast",
			});
		}
		expect(notify).toHaveBeenCalledWith("Service tier is fixed to ultrafast by the active model selection.", "info");
	});

	it("preserves an Ultrafast pin in an extension-less session with fast mode already on", async () => {
		const harness = await createHarness({ serviceTier: "ultrafast" });
		harnesses.push(harness);
		harness.session.setSessionFastMode(true);
		expect(harness.session.effectiveServiceTier).toBe("ultrafast");
	});
});
