import { readFileSync } from "node:fs";
import { type AssistantMessage, fauxAssistantMessage, type ProviderDiagnostic } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { toJsonEvent } from "../../src/modes/json-event.ts";
import { createRpcConnectionHandler, type RpcConnectionSink } from "../../src/modes/rpc/connection-handler.ts";
import { createHarness, type Harness } from "./harness.ts";

// senpi#2197: a provider adapter's providerDiagnostic reaches AgentSession events, the
// persisted session JSONL, print-mode JSON events, and RPC events + get_state unchanged.

const DIAGNOSTIC: ProviderDiagnostic = {
	category: "rate_limit",
	httpStatus: 429,
	code: "rate_limit_error",
	evidence: "structured_code",
};

interface WireRecord {
	id?: string;
	type?: string;
	data?: Record<string, unknown>;
	message?: { role?: string; providerDiagnostic?: unknown };
}

function createRuntimeHost(session: AgentSession): AgentSessionRuntime {
	return {
		session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;
}

function failedTurn(providerDiagnostic?: ProviderDiagnostic): AssistantMessage {
	const message = fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limited by provider" });
	return providerDiagnostic === undefined ? message : { ...message, providerDiagnostic };
}

describe("providerDiagnostic propagation through the session surfaces", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
		vi.restoreAllMocks();
	});

	async function createRpcHarness(): Promise<{
		harness: Harness;
		send(command: Record<string, unknown>): Promise<WireRecord>;
		records(): WireRecord[];
	}> {
		const harness = await createHarness({ persistSession: true, settings: { retry: { enabled: false } } });
		cleanups.push(harness.cleanup);
		await harness.session.bindExtensions({});
		const lines: string[] = [];
		const sink: RpcConnectionSink = {
			writeRaw: (chunk) => lines.push(chunk),
			waitForBackpressure: async () => {},
		};
		const handler = createRpcConnectionHandler(createRuntimeHost(harness.session), sink);
		cleanups.push(() => handler.dispose());
		await handler.ready;
		const records = (): WireRecord[] =>
			lines
				.join("")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as WireRecord);
		let sequence = 0;
		return {
			harness,
			records,
			send: async (command) => {
				const id = `rpc-${++sequence}`;
				await handler.handleInputLine(JSON.stringify({ id, ...command }));
				const response = records().find((record) => record.id === id && record.type === "response");
				if (!response) throw new Error(`Missing RPC response for ${JSON.stringify(command)}`);
				return response;
			},
		};
	}

	it("carries the diagnostic to session events, JSONL, print JSON, and RPC events + get_state", async () => {
		const rpc = await createRpcHarness();
		rpc.harness.setResponses([failedTurn(DIAGNOSTIC)]);

		await rpc.harness.session.prompt("hello");

		const assistantEnd = rpc.harness.eventsOfType("message_end").find((event) => event.message.role === "assistant");
		if (assistantEnd?.message.role !== "assistant") throw new Error("Expected an assistant message_end");
		expect(assistantEnd.message.errorMessage).toBe("429 rate limited by provider");
		expect(assistantEnd.message.providerDiagnostic).toEqual(DIAGNOSTIC);

		const printed = JSON.parse(JSON.stringify(toJsonEvent(assistantEnd))) as WireRecord;
		expect(printed.message?.providerDiagnostic).toEqual(DIAGNOSTIC);

		const sessionFile = rpc.harness.session.sessionFile;
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const persisted = readFileSync(sessionFile, "utf-8")
			.split("\n")
			.filter(Boolean)
			.map(
				(line) => JSON.parse(line) as { type?: string; message?: { role?: string; providerDiagnostic?: unknown } },
			)
			.find((entry) => entry.type === "message" && entry.message?.role === "assistant");
		expect(persisted?.message?.providerDiagnostic).toEqual(DIAGNOSTIC);

		const wireEnd = rpc
			.records()
			.find((record) => record.type === "message_end" && record.message?.role === "assistant");
		expect(wireEnd?.message?.providerDiagnostic).toEqual(DIAGNOSTIC);

		const state = await rpc.send({ type: "get_state" });
		expect(state.data?.lastProviderDiagnostic).toEqual(DIAGNOSTIC);
	});

	it("omits lastProviderDiagnostic when the failed turn carries none", async () => {
		const rpc = await createRpcHarness();
		rpc.harness.setResponses([failedTurn()]);

		await rpc.harness.session.prompt("hello");

		const state = await rpc.send({ type: "get_state" });
		expect(state.data !== undefined && "lastProviderDiagnostic" in state.data).toBe(false);
	});
});
