import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

// Issue #1422: `compaction.enabled=false` must only switch off proactive
// (threshold) compaction. A provider-confirmed context overflow is an error the
// session cannot progress past by any other route, so its one-shot
// compact-and-retry recovery has to stay armed regardless of the flag.

type CheckCompaction = (assistantMessage: AssistantMessage) => Promise<boolean>;
type RunAutoCompaction = (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;

function getCheckCompaction(session: Harness["session"]): CheckCompaction {
	const value: unknown = Reflect.get(session, "_checkCompaction");
	if (typeof value !== "function") {
		throw new Error("AgentSession._checkCompaction is not available for regression tests");
	}
	return async (assistantMessage) => (await value.call(session, assistantMessage)) === true;
}

function getAutoCompactionReason(
	session: Harness["session"],
): (assistantMessage: AssistantMessage) => "overflow" | "threshold" | undefined {
	const value: unknown = Reflect.get(session, "_getAutoCompactionReason");
	if (typeof value !== "function") {
		throw new Error("AgentSession._getAutoCompactionReason is not available for regression tests");
	}
	return (assistantMessage) => {
		const reason: unknown = value.call(session, assistantMessage);
		if (reason === "overflow" || reason === "threshold" || reason === undefined) return reason;
		throw new Error(`Unexpected auto-compaction reason: ${String(reason)}`);
	};
}

function stubRunAutoCompaction(session: Harness["session"]) {
	const stub = vi.fn<RunAutoCompaction>(async () => true);
	Reflect.set(session, "_runAutoCompaction", stub);
	return stub;
}

function usage(totalTokens: number): AssistantMessage["usage"] {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(
	harness: Harness,
	overrides: Partial<AssistantMessage> & Pick<AssistantMessage, "stopReason">,
): AssistantMessage {
	const model = harness.getModel();
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: usage(0),
		timestamp: Date.now(),
		...overrides,
	};
}

describe("#1422 overflow recovery with auto-compaction disabled", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) {
			harness.cleanup();
		}
		vi.restoreAllMocks();
	});

	it("runs the one-shot compact-and-retry when the provider rejects the context and auto-compaction is off", async () => {
		//#given - auto-compaction disabled, the last turn ended with a provider overflow error
		const harness = await createHarness({
			api: "openai-responses",
			provider: "openai",
			models: [{ id: "gpt-6-astra", contextWindow: 922_000 }],
			settings: { compaction: { enabled: false } },
		});
		harnesses.push(harness);
		const overflow = assistant(harness, {
			stopReason: "error",
			errorMessage:
				"Error Code context_too_large: Your input exceeds the context window of this model. Please adjust your input and try again.",
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "continue" }], timestamp: Date.now() - 1 },
			overflow,
		];
		const runAutoCompaction = stubRunAutoCompaction(harness.session);

		//#when - the post-turn compaction check runs for that error
		const recovered = await getCheckCompaction(harness.session)(overflow);

		//#then - overflow recovery compacts and retries even though threshold compaction is disabled
		expect(recovered).toBe(true);
		expect(runAutoCompaction).toHaveBeenCalledTimes(1);
		expect(runAutoCompaction).toHaveBeenCalledWith("overflow", true);
	});

	it("still classifies a provider overflow as an overflow reason when auto-compaction is off", async () => {
		//#given
		const harness = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(harness);
		const overflow = assistant(harness, { stopReason: "error", errorMessage: "prompt is too long" });

		//#when
		const reason = getAutoCompactionReason(harness.session)(overflow);

		//#then - queue ownership and admission keep treating it as a required recovery
		expect(reason).toBe("overflow");
	});

	it("keeps threshold compaction off when auto-compaction is disabled", async () => {
		//#given - a successful response far past the reserve threshold
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 5_000 }],
			settings: { compaction: { enabled: false, reserveTokens: 1_000 } },
		});
		harnesses.push(harness);
		const oversized = assistant(harness, { stopReason: "stop", usage: usage(4_900) });
		const runAutoCompaction = stubRunAutoCompaction(harness.session);

		//#when
		const reason = getAutoCompactionReason(harness.session)(oversized);
		const compacted = await getCheckCompaction(harness.session)(oversized);

		//#then - proactive compaction is the user's call; nothing runs
		expect(reason).toBeUndefined();
		expect(compacted).toBe(false);
		expect(runAutoCompaction).not.toHaveBeenCalled();
	});
});
