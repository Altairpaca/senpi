import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
	type ProviderHeaders,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { generateSummaryMessage } from "../../src/core/extensions/builtin/compaction/speculative-summary.ts";
import type {
	SpeculativeCompactionContext,
	SpeculativeCompactionSnapshot,
} from "../../src/core/extensions/builtin/compaction/speculative.ts";
import type { ModelRegistry } from "../../src/core/model-registry.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

function createModel(provider = "opencode-go", baseUrl = "https://opencode.ai/zen/go/v1/messages"): Model<any> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions",
		provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4_096,
	};
}

function completedStream(model: Model<any>) {
	const stream = createAssistantMessageEventStream();
	stream.end({
		...fauxAssistantMessage("summary"),
		api: model.api,
		provider: model.provider,
		model: model.id,
	});
	return stream;
}

async function captureSummaryHeaders(options: {
	model: Model<any>;
	transformHeaders?: (headers: ProviderHeaders) => ProviderHeaders | Promise<ProviderHeaders>;
}): Promise<ProviderHeaders | undefined> {
	let capturedHeaders: ProviderHeaders | undefined;
	const sessionManager = SessionManager.inMemory();
	sessionManager.newSession({ id: "session-1523" });

	const modelRuntime = {
		stream: (model: Model<any>, _context: unknown, streamOptions?: { headers?: ProviderHeaders }) => {
			capturedHeaders = streamOptions?.headers;
			return completedStream(model);
		},
	};
	const context: SpeculativeCompactionContext = {
		model: options.model,
		modelRegistry: { modelRuntime } as unknown as ModelRegistry,
		sessionManager,
		getContextUsage: () => undefined,
		getMessageRevision: () => 1,
		prepareProviderRequest: async (messages) => ({
			messages,
			transformPayload: async (payload) => payload,
			transformHeaders: async (headers) =>
				options.transformHeaders ? await options.transformHeaders(headers) : headers,
		}),
		applyCompaction: async () => ({ applied: true, reason: "ok" }),
	};
	const snapshot = {
		model: options.model,
		contextWindow: options.model.contextWindow,
		systemPrompt: "system",
		tools: [],
	} as unknown as SpeculativeCompactionSnapshot;

	await generateSummaryMessage({
		context,
		messages: [{ role: "user", content: [{ type: "text", text: "history" }], timestamp: 1 }],
		prompt: { system: "system", user: "summarize" } as never,
		snapshot,
		auth: {},
	});
	return capturedHeaders;
}

describe("issue #1523: compaction provider session attribution", () => {
	it("sends the OpenCode session headers on builtin summarization", async () => {
		const headers = await captureSummaryHeaders({ model: createModel() });

		expect(headers?.["x-opencode-session"]).toBe("session-1523");
		expect(headers?.["x-opencode-client"]).toBe("pi");
	});

	it("keeps before-provider header transforms authoritative", async () => {
		const headers = await captureSummaryHeaders({
			model: createModel(),
			transformHeaders: (input) => ({
				...input,
				"x-opencode-session": "extension-session",
				"x-opencode-client": "extension-client",
			}),
		});

		expect(headers?.["x-opencode-session"]).toBe("extension-session");
		expect(headers?.["x-opencode-client"]).toBe("extension-client");
	});

	it("does not add OpenCode session headers for unrelated providers", async () => {
		const headers = await captureSummaryHeaders({
			model: createModel("example", "https://example.test/v1"),
		});

		expect(headers?.["x-opencode-session"]).toBeUndefined();
		expect(headers?.["x-opencode-client"]).toBeUndefined();
	});
});
