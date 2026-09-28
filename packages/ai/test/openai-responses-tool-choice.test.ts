import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel, stream } from "../src/compat.ts";
import type { Tool } from "../src/types.ts";

type MockEvent =
	| { type: "response.output_text.delta"; delta: string }
	| { type: "response.completed"; response: { id: string; usage?: unknown } };

interface OpenAIMockState {
	lastParams: unknown | undefined;
	calls: unknown[];
	createErrors: Error[];
	events: MockEvent[] | undefined;
}

const mockState = vi.hoisted<OpenAIMockState>(() => ({
	lastParams: undefined,
	calls: [],
	createErrors: [],
	events: undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		responses = {
			create: (params: unknown) => {
				mockState.lastParams = params;
				mockState.calls.push(params);
				const createError = mockState.createErrors.shift();
				const eventStream = {
					async *[Symbol.asyncIterator]() {
						const events = mockState.events ?? [
							{ type: "response.output_text.delta", delta: "ok" },
							{
								type: "response.completed",
								response: {
									id: "resp_test",
									usage: {
										input_tokens: 1,
										output_tokens: 1,
										output_tokens_details: { reasoning_tokens: 0 },
									},
								},
							},
						];
						for (const event of events) {
							yield event;
						}
					},
				};
				const promise = Promise.resolve(eventStream) as Promise<typeof eventStream> & {
					withResponse: () => Promise<{
						data: typeof eventStream;
						response: { status: number; headers: Headers };
					}>;
				};
				promise.withResponse = async () => {
					if (createError) {
						throw createError;
					}
					return {
						data: eventStream,
						response: { status: 200, headers: new Headers() },
					};
				};
				return promise;
			},
		};
	}

	return { default: FakeOpenAI };
});

class HttpStatusError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function recordAt(values: readonly unknown[], index: number): Record<string, unknown> {
	const value = values[index];
	if (!isRecord(value)) {
		throw new Error(`Expected mock call ${index} to be a record`);
	}
	return value;
}

function makeResponsesModel() {
	const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
	return { ...baseModel, api: "openai-responses" } as const;
}

describe("openai-responses tool_choice fallback", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
		mockState.calls.length = 0;
		mockState.createErrors.length = 0;
		mockState.events = undefined;
	});

	it("retries forced toolChoice 400 once without tool_choice", async () => {
		mockState.createErrors.push(new HttpStatusError(400, "tool_choice is not supported by this model"));

		const model = makeResponsesModel();
		const tools: Tool[] = [
			{
				name: "ping",
				description: "Ping tool",
				parameters: Type.Object({
					ok: Type.Boolean(),
				}),
			},
		];

		const response = await stream(
			model,
			{
				messages: [{ role: "user", content: "Call ping with ok=true", timestamp: Date.now() }],
				tools,
			},
			{
				apiKey: "test",
				toolChoice: "required",
			},
		).result();

		const firstParams = recordAt(mockState.calls, 0);
		const secondParams = recordAt(mockState.calls, 1);
		expect(response.stopReason).toBe("stop");
		expect(mockState.calls).toHaveLength(2);
		expect(firstParams.tool_choice).toBe("required");
		expect(secondParams.tool_choice).toBeUndefined();
	});

	it("retries without tool_choice when an auto-only gateway model refuses the forced choice (#2224)", async () => {
		// Observed on OmniRoute for opencode-go/muse-spark-1.3-contributor, 2026-09-27.
		mockState.createErrors.push(
			new HttpStatusError(
				400,
				`400: only \`"auto"\` is supported for \`tool_choice\`. \`"none"\`, \`"required"\`, and named function choices are not currently supported`,
			),
		);

		const model = makeResponsesModel();
		const tools: Tool[] = [
			{ name: "todo", description: "Todo tool", parameters: Type.Object({ op: Type.String() }) },
		];

		const response = await stream(
			model,
			{ messages: [{ role: "user", content: "Plan the work", timestamp: Date.now() }], tools },
			{ apiKey: "test", toolChoice: { type: "function", name: "todo" } },
		).result();

		expect(response.stopReason).toBe("stop");
		expect(mockState.calls).toHaveLength(2);
		expect(recordAt(mockState.calls, 0).tool_choice).toEqual({ type: "function", name: "todo" });
		expect(recordAt(mockState.calls, 1).tool_choice).toBeUndefined();
	});

	it("does not retry when tool_choice was not forced", async () => {
		mockState.createErrors.push(new HttpStatusError(400, "tool_choice is not supported by this model"));

		const model = makeResponsesModel();
		const tools: Tool[] = [
			{ name: "ping", description: "Ping tool", parameters: Type.Object({ ok: Type.Boolean() }) },
		];

		const response = await stream(
			model,
			{
				messages: [{ role: "user", content: "Call ping with ok=true", timestamp: Date.now() }],
				tools,
			},
			{
				apiKey: "test",
				toolChoice: "auto",
			},
		).result();

		expect(response.stopReason).toBe("error");
		expect(mockState.calls).toHaveLength(1);
		expect(recordAt(mockState.calls, 0).tool_choice).toBe("auto");
	});
});
