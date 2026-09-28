import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { streamSimple as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { streamSimple as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { streamSimple as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import type { Api, AssistantMessage, Context, Model, Tool } from "../src/types.ts";

const COPILOT_TOOL_LIMIT = 128;

function makeTools(count: number): Tool[] {
	return Array.from({ length: count }, (_, index) => ({
		name: `tool_${index}`,
		description: `Tool ${index}`,
		parameters: Type.Object({}),
	}));
}

function makeModel<TApi extends Api>(api: TApi): Model<TApi> {
	return {
		id: "test-model",
		name: "Test model",
		api,
		provider: "github-copilot",
		baseUrl: "https://api.individual.githubcopilot.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

function makeContext(): Context {
	return {
		messages: [{ role: "user", content: "Use a tool.", timestamp: 1 }],
		tools: makeTools(COPILOT_TOOL_LIMIT + 2),
	};
}

async function captureRequest(
	run: (fetch: typeof globalThis.fetch) => Promise<AssistantMessage>,
): Promise<{ payload: { tools?: unknown[] }; result: AssistantMessage }> {
	let payload: { tools?: unknown[] } | undefined;
	const fetch: typeof globalThis.fetch = async (_input, init) => {
		payload = JSON.parse(String(init?.body)) as { tools?: unknown[] };
		return new Response("Bad Request", { status: 400, headers: { "content-type": "text/plain" } });
	};
	const result = await run(fetch);
	if (payload === undefined) throw new Error("Expected the adapter to send a request");
	return { payload, result };
}

function expectLimited(payload: { tools?: unknown[] }, result: AssistantMessage): void {
	expect(payload.tools).toHaveLength(COPILOT_TOOL_LIMIT);
	expect(result.diagnostics).toContainEqual(
		expect.objectContaining({
			type: "github_copilot_tool_limit",
			timestamp: expect.any(Number),
			details: expect.objectContaining({ limit: COPILOT_TOOL_LIMIT, omittedCount: 2 }),
		}),
	);
}

describe("GitHub Copilot tool limit", () => {
	it("limits Chat Completions requests and reports omitted tools", async () => {
		const context = makeContext();
		const { payload, result } = await captureRequest((fetch) =>
			streamOpenAICompletions(makeModel("openai-completions"), context, {
				apiKey: "test-key",
				fetch,
				maxRetries: 0,
			}).result(),
		);

		expectLimited(payload, result);
		expect(result.errorMessage).toContain("senpi limited its tool list to 128");
		expect(context.tools).toHaveLength(COPILOT_TOOL_LIMIT + 2);
	});

	it("limits Responses requests and reports omitted tools", async () => {
		const context = makeContext();
		const { payload, result } = await captureRequest((fetch) =>
			streamOpenAIResponses(makeModel("openai-responses"), context, {
				apiKey: "test-key",
				fetch,
				maxRetries: 0,
			}).result(),
		);

		expectLimited(payload, result);
	});

	it("limits Anthropic Messages requests and reports omitted tools", async () => {
		const context = makeContext();
		const { payload, result } = await captureRequest((fetch) =>
			streamAnthropic(makeModel("anthropic-messages"), context, {
				apiKey: "test-key",
				fetch,
				maxRetries: 0,
			}).result(),
		);

		expectLimited(payload, result);
	});
});
