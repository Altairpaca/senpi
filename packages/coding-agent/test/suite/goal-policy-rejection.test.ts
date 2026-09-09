import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readGoal } from "../../src/core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../src/core/extensions/builtin/goal/store-ref.ts";
import type { AgentEndEvent } from "../../src/core/extensions/types.ts";
import {
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	makeGoalContext,
	runGoalHandlers,
} from "./goal-monitor-test-harness.ts";

const CODEX_POLICY_ERROR =
	"Codex error: This request was blocked by our safety systems. Reason: Potentially unintended activity.";

async function setupGoal() {
	const harness = createGoalHarness();
	const ctx = await makeGoalContext([], "policy-rejection");
	const create = harness.tools.get("create_goal");
	if (create === undefined) throw new Error("create_goal was not registered");
	await create.execute("create", { objective: "Preserve unfinished work" }, undefined, undefined, ctx);
	const goal = await readGoal(goalStoreRef(ctx.sessionManager, ctx.cwd));
	await runGoalHandlers(harness.handlers, "agent_start", { type: "agent_start" }, ctx);
	return { harness, ctx, goal };
}

afterEach(async () => {
	vi.useRealTimers();
	await cleanupGoalMonitorTempDirs();
});

describe("terminal policy goal recovery", () => {
	// Regression for #1520: exercise agent_end routing through the real monitor's
	// agent_settled admission and sendMessage, not just the error predicate.
	it.each([
		[
			"Codex backend policy error",
			fauxAssistantMessage("", { stopReason: "error", errorMessage: CODEX_POLICY_ERROR }),
		],
		["structured refusal", fauxAssistantMessage("", { stopReason: "error", stopDetails: { type: "refusal" } })],
		[
			"structured sensitive stop",
			fauxAssistantMessage("", { stopReason: "error", stopDetails: { type: "sensitive" } }),
		],
		[
			"refusal with empty toolUse",
			fauxAssistantMessage("", { stopReason: "toolUse", stopDetails: { type: "refusal" } }),
		],
		[
			"sensitive empty toolUse",
			fauxAssistantMessage("", { stopReason: "toolUse", stopDetails: { type: "sensitive" } }),
		],
		[
			"Anthropic policy error",
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage:
					"This request triggered restrictions on output and was blocked under Anthropic's Usage Policy",
			}),
		],
	])("blocks %s without consuming a continuation or losing the goal", async (_name, message) => {
		const { harness, ctx, goal } = await setupGoal();
		const event: AgentEndEvent = { type: "agent_end", messages: [message], willRetry: false };

		await runGoalHandlers(harness.handlers, "agent_end", event, ctx);
		await runGoalHandlers(harness.handlers, "agent_settled", { type: "agent_settled" }, ctx);
		await runGoalHandlers(harness.handlers, "agent_settled", { type: "agent_settled" }, ctx);

		expect(harness.sent).toHaveLength(0);
		expect(await readGoal(goalStoreRef(ctx.sessionManager, ctx.cwd))).toMatchObject({
			id: goal?.id,
			objective: goal?.objective,
			status: "blocked",
			consecutiveContinuations: 0,
			unattendedContinuations: 0,
		});
	});

	it.each([
		["overload", "overloaded_error", undefined],
		["unknown infrastructure", "upstream connection closed", undefined],
		["provider watchdog", "Idle timeout waiting for provider stream after 1000ms", "provider"],
		["system recovery", "Provider stream start timed out after 1000ms", "system"],
	] as const)("preserves one settled recovery for %s", async (_name, errorMessage, abortSource) => {
		const { harness, ctx, goal } = await setupGoal();
		const event: AgentEndEvent = {
			type: "agent_end",
			messages: [fauxAssistantMessage("", { stopReason: "error", errorMessage })],
			willRetry: false,
			abortSource,
			aborted: abortSource !== undefined,
		};

		await runGoalHandlers(harness.handlers, "agent_end", event, ctx);
		expect(harness.sent).toHaveLength(0);
		await runGoalHandlers(harness.handlers, "agent_settled", { type: "agent_settled" }, ctx);
		await runGoalHandlers(harness.handlers, "agent_settled", { type: "agent_settled" }, ctx);

		expect(harness.sent).toHaveLength(1);
		expect(harness.sent[0]?.message.customType).toBe("goal-continuation");
		expect(await readGoal(goalStoreRef(ctx.sessionManager, ctx.cwd))).toMatchObject({
			id: goal?.id,
			status: "active",
			consecutiveContinuations: 1,
			unattendedContinuations: 1,
		});
	});

	it.each([CODEX_POLICY_ERROR, "overloaded_error"])(
		"leaves an explicit retry owner in control: %s",
		async (errorMessage) => {
			const { harness, ctx } = await setupGoal();
			await runGoalHandlers(
				harness.handlers,
				"agent_end",
				{
					type: "agent_end",
					messages: [fauxAssistantMessage("", { stopReason: "error", errorMessage })],
					willRetry: true,
				},
				ctx,
			);
			await runGoalHandlers(harness.handlers, "agent_settled", { type: "agent_settled" }, ctx);

			expect(harness.sent).toHaveLength(0);
			expect(await readGoal(goalStoreRef(ctx.sessionManager, ctx.cwd))).toMatchObject({
				status: "active",
				consecutiveContinuations: 0,
			});
		},
	);

	it("does not treat ordinary assistant text about safety blocks as a policy error", async () => {
		const { harness, ctx } = await setupGoal();
		await runGoalHandlers(
			harness.handlers,
			"agent_end",
			{
				type: "agent_end",
				messages: [fauxAssistantMessage(CODEX_POLICY_ERROR)],
				willRetry: false,
			},
			ctx,
		);
		expect(harness.sent).toHaveLength(1);
	});

	it("disarms a live monitor backstop on policy rejection, including system abort provenance", async () => {
		vi.useFakeTimers();
		const { harness, ctx } = await setupGoal();
		harness.events.emit("terminal_monitor_state", { activeCount: 1 });
		await harness.events.flush();
		await runGoalHandlers(
			harness.handlers,
			"agent_end",
			{
				type: "agent_end",
				messages: [fauxAssistantMessage("Waiting")],
				willRetry: false,
			},
			ctx,
		);
		expect(harness.events.emitted.some((event) => event.channel === "goal_continuation_scheduled")).toBe(true);

		await runGoalHandlers(
			harness.handlers,
			"agent_end",
			{
				type: "agent_end",
				aborted: true,
				abortSource: "system",
				willRetry: false,
				messages: [fauxAssistantMessage("", { stopReason: "error", errorMessage: CODEX_POLICY_ERROR })],
			},
			ctx,
		);
		await runGoalHandlers(harness.handlers, "agent_settled", { type: "agent_settled" }, ctx);
		await vi.runOnlyPendingTimersAsync();

		expect(harness.sent).toHaveLength(0);
		expect(await readGoal(goalStoreRef(ctx.sessionManager, ctx.cwd))).toMatchObject({
			status: "blocked",
			consecutiveContinuations: 0,
		});
	});
});
