import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/api/openai-completions.ts";
import { parseEndpointReasoningEfforts } from "../src/endpoint-reasoning-efforts.ts";
import { clampThinkingLevel, getSupportedThinkingLevels } from "../src/models.ts";
import type { Context, Model } from "../src/types.ts";

// senpi#2196: OpenAI-compatible /models listings advertise per-model reasoning_efforts.
describe("parseEndpointReasoningEfforts", () => {
	it("maps advertised values onto senpi levels, keeps the endpoint spelling, and vetoes the rest", () => {
		const parsed = parseEndpointReasoningEfforts([{ value: "low" }, { value: "High", default: true }]);

		expect(parsed).toEqual({
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: "low",
				medium: null,
				high: "High",
				xhigh: null,
				max: null,
			},
			defaultThinkingLevel: "high",
			unmapped: [],
		});
	});

	it("maps none/off to the off level and accepts plain string entries", () => {
		const parsed = parseEndpointReasoningEfforts(["none", "medium", "xhigh", "max"]);

		expect(parsed?.thinkingLevelMap).toEqual({
			off: "none",
			minimal: null,
			low: null,
			medium: "medium",
			high: null,
			xhigh: "xhigh",
			max: "max",
		});
		expect(parsed?.defaultThinkingLevel).toBeUndefined();
	});

	it("reports names it cannot map and never uses them as the default", () => {
		const parsed = parseEndpointReasoningEfforts([
			{ value: "turbo", default: true },
			{ value: "low" },
			{ value: "LOW" },
		]);

		expect(parsed?.unmapped).toEqual(["turbo"]);
		expect(parsed?.defaultThinkingLevel).toBeUndefined();
		expect(parsed?.thinkingLevelMap?.low).toBe("low");
	});

	it("returns no map when nothing maps, and nothing for absent or malformed listings", () => {
		expect(parseEndpointReasoningEfforts([{ value: "turbo" }])).toEqual({ unmapped: ["turbo"] });
		expect(parseEndpointReasoningEfforts(undefined)).toBeUndefined();
		expect(parseEndpointReasoningEfforts([])).toBeUndefined();
		expect(parseEndpointReasoningEfforts({ value: "low" })).toBeUndefined();
		expect(parseEndpointReasoningEfforts([{ value: 3 }, null, { default: true }])).toBeUndefined();
	});
});

describe("models configured from endpoint reasoning efforts", () => {
	const parsed = parseEndpointReasoningEfforts([{ value: "low" }, { value: "High", default: true }]);
	const model: Model<"openai-completions"> = {
		id: "endpoint-effort-model",
		name: "endpoint-effort-model",
		api: "openai-completions",
		provider: "local-endpoint",
		baseUrl: "http://127.0.0.1:9",
		reasoning: true,
		thinkingLevelMap: parsed?.thinkingLevelMap,
		defaultThinkingLevel: parsed?.defaultThinkingLevel,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
		// Id-based inference would add xhigh for this family; the endpoint map must win.
		compat: { supportsReasoningEffort: true },
	};

	it("offers only the advertised levels, skipping id-based inference", () => {
		expect(getSupportedThinkingLevels({ ...model, id: "gpt-5.5" })).toEqual(["low", "high"]);
		expect(clampThinkingLevel(model, "medium")).toBe("high");
	});

	it("sends the endpoint's original effort name on the wire", async () => {
		const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] };
		let payload: { reasoning_effort?: string } | undefined;
		const result = streamSimple(model, context, {
			apiKey: "fake-key",
			reasoning: "high",
			onPayload: (captured) => {
				payload = captured as { reasoning_effort?: string };
				return captured;
			},
		});
		await result.result();

		expect(payload?.reasoning_effort).toBe("High");
	});
});
