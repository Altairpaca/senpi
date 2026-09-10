import { afterEach, describe, expect, it } from "vitest";
import { ModelUsabilityBudgetError } from "../../src/core/extensions/builtin/compaction/model-usability-budget.ts";
import { createHarness, type Harness } from "./harness.ts";

// https://github.com/code-yeongyu/senpi/issues/1526
// A switch refused by the context-window guard threw before `_switchActiveModel`
// ran, so nothing reached the session entries or the event stream: the attempt
// was indistinguishable from never having been made.
describe("rejected model switch", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function oversizedHarness(): Promise<Harness> {
		const harness = await createHarness({
			models: [
				{ id: "faux-roomy", name: "Roomy", contextWindow: 200_000 },
				{ id: "faux-small", name: "Too Small", contextWindow: 5_120 },
			],
		});
		harnesses.push(harness);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "context ".repeat(3_000) }],
			timestamp: Date.now(),
		});
		return harness;
	}

	function tooSmall(harness: Harness) {
		const model = harness.getModel("faux-small");
		if (!model) throw new Error("expected the small-context faux model");
		return model;
	}

	it("#given a target that cannot hold the live context #when the switch is refused #then a rejection entry is appended", async () => {
		const harness = await oversizedHarness();
		const target = tooSmall(harness);
		const before = harness.sessionManager.getBranch().length;

		await expect(harness.session.setModel(target)).rejects.toBeInstanceOf(ModelUsabilityBudgetError);

		const appended = harness.sessionManager.getBranch().slice(before);
		const rejection = appended.find((entry) => entry.type === "model_change_rejected");
		expect(rejection).toMatchObject({
			type: "model_change_rejected",
			provider: target.provider,
			modelId: target.id,
			reason: "context-budget",
			contextWindow: target.contextWindow,
		});
		// The operator-actionable numbers must survive in the record, not only in
		// the transient error message. `liveContextTokens` is deliberately not
		// asserted non-zero: `_getDownswitchLiveContextTokens` reports 0 whenever
		// the target's usable context is not smaller than the current model's, so a
		// fixed expectation there would pin harness geometry rather than behavior.
		const recorded = rejection as unknown as {
			shortfallTokens: number;
			requiredTokens: number;
			liveContextTokens: number;
			detail: string;
		};
		expect(recorded.shortfallTokens).toBeGreaterThan(0);
		expect(recorded.requiredTokens).toBeGreaterThan(target.contextWindow);
		expect(typeof recorded.liveContextTokens).toBe("number");
		// The remedy the guard already names must reach the durable record.
		expect(recorded.detail).toContain("Compact the session");
	});

	it("#given a refused switch #when subscribers observe the session #then a rejection event carries the same numbers", async () => {
		const harness = await oversizedHarness();
		const target = tooSmall(harness);

		await expect(harness.session.setModel(target)).rejects.toBeInstanceOf(ModelUsabilityBudgetError);

		const observed = harness.eventsOfType("model_change_rejected");
		expect(observed).toHaveLength(1);
		expect(observed[0]).toMatchObject({ reason: "context-budget", contextWindow: target.contextWindow });
		expect(observed[0]?.model.id).toBe(target.id);
	});

	it("#given the refusal #when the session continues #then the active model is unchanged", async () => {
		const harness = await oversizedHarness();
		const roomy = harness.getModel();

		await expect(harness.session.setModel(tooSmall(harness))).rejects.toBeInstanceOf(ModelUsabilityBudgetError);

		expect(harness.session.model?.id).toBe(roomy.id);
	});

	it("#given an admissible target #when the switch succeeds #then no rejection is recorded", async () => {
		const harness = await oversizedHarness();
		const roomy = harness.getModel();
		const before = harness.sessionManager.getBranch().length;

		await harness.session.setModel(roomy);

		const appended = harness.sessionManager.getBranch().slice(before);
		expect(appended.filter((entry) => entry.type === "model_change_rejected")).toEqual([]);
		expect(harness.eventsOfType("model_change_rejected")).toEqual([]);
		expect(harness.session.model?.id).toBe(roomy.id);
	});
});
