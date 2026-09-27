import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverProviderModels } from "../../src/core/model-discovery.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";

// senpi#2196: `senpi models discover` honors reasoning_efforts advertised by /models.
interface Listing {
	status: number;
	body: unknown;
}

describe("discoverProviderModels", () => {
	let tempDir: string;
	let modelsPath: string;
	let server: Server;
	let baseUrl: string;
	let listing: Listing;
	const requests: Array<{ url: string | undefined; headers: IncomingHttpHeaders }> = [];

	beforeEach(async () => {
		tempDir = join(tmpdir(), `senpi-2196-discover-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		modelsPath = join(tempDir, "models.json");
		requests.length = 0;
		listing = {
			status: 200,
			body: {
				object: "list",
				data: [
					{ id: "effort-model", reasoning_efforts: [{ value: "low" }, { value: "High", default: true }] },
					{ id: "plain-model" },
				],
			},
		};
		server = createServer((request, response) => {
			requests.push({ url: request.url, headers: request.headers });
			response.writeHead(listing.status, { "content-type": "application/json" });
			response.end(JSON.stringify(listing.body));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeProvider(provider: Record<string, unknown>): void {
		writeFileSync(
			modelsPath,
			JSON.stringify(
				{ providers: { local: { baseUrl, api: "openai-completions", apiKey: "test-key", ...provider } } },
				null,
				2,
			),
		);
	}

	function providerModels(): unknown {
		return (JSON.parse(readFileSync(modelsPath, "utf-8")) as { providers: { local: { models?: unknown } } }).providers
			.local.models;
	}

	it("writes advertised efforts as a thinkingLevelMap and default when the compat flag is on", async () => {
		writeProvider({ compat: { supportsReasoningEffort: true } });

		const report = await discoverProviderModels({ providerId: "local", modelsPath, auth: { apiKey: "test-key" } });

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("/v1/models");
		expect(requests[0]?.headers.authorization).toBe("Bearer test-key");
		expect(report.added).toEqual(["effort-model", "plain-model"]);
		expect(report.efforts["effort-model"]).toEqual({
			levels: ["low", "high"],
			defaultThinkingLevel: "high",
			unmapped: [],
		});
		expect(providerModels()).toEqual([
			{
				id: "effort-model",
				reasoning: true,
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
			},
			{ id: "plain-model" },
		]);

		const runtime = await ModelRuntime.create({
			modelsPath,
			authPath: join(tempDir, "auth.json"),
			allowModelNetwork: false,
		});
		const model = runtime.getModel("local", "effort-model");
		expect(runtime.getError()).toBeUndefined();
		expect(model?.defaultThinkingLevel).toBe("high");
		expect(getSupportedThinkingLevels(model!)).toEqual(["low", "high"]);
	});

	it("ignores advertised efforts without compat.supportsReasoningEffort", async () => {
		writeProvider({});

		const report = await discoverProviderModels({ providerId: "local", modelsPath, auth: { apiKey: "test-key" } });

		expect(report.effortsIgnored).toBe(true);
		expect(report.efforts).toEqual({});
		expect(providerModels()).toEqual([{ id: "effort-model" }, { id: "plain-model" }]);
	});

	it("keeps an existing entry's own fields, backs up the original, and is idempotent", async () => {
		writeProvider({
			compat: { supportsReasoningEffort: true },
			models: [{ id: "effort-model", name: "Mine", contextWindow: 64000 }],
		});
		const original = readFileSync(modelsPath, "utf-8");

		const first = await discoverProviderModels({ providerId: "local", modelsPath, auth: { apiKey: "test-key" } });

		expect(first.updated).toEqual(["effort-model"]);
		expect(first.added).toEqual(["plain-model"]);
		expect(first.backupPath && readFileSync(first.backupPath, "utf-8")).toBe(original);
		expect((providerModels() as Array<Record<string, unknown>>)[0]).toMatchObject({
			id: "effort-model",
			name: "Mine",
			contextWindow: 64000,
			defaultThinkingLevel: "high",
		});

		const rewritten = readFileSync(modelsPath, "utf-8");
		const second = await discoverProviderModels({ providerId: "local", modelsPath, auth: { apiKey: "test-key" } });
		expect(second.written).toBe(false);
		expect(second.unchanged).toEqual(["effort-model", "plain-model"]);
		expect(readFileSync(modelsPath, "utf-8")).toBe(rewritten);
	});

	it("fails without touching models.json when the listing request fails", async () => {
		writeProvider({ compat: { supportsReasoningEffort: true } });
		const original = readFileSync(modelsPath, "utf-8");
		listing = { status: 500, body: { error: "boom" } };

		await expect(discoverProviderModels({ providerId: "local", modelsPath, auth: {} })).rejects.toThrow("500");
		expect(readFileSync(modelsPath, "utf-8")).toBe(original);
	});

	it("rejects a malformed listing and an unknown provider", async () => {
		writeProvider({});
		listing = { status: 200, body: { data: "nope" } };

		await expect(discoverProviderModels({ providerId: "local", modelsPath, auth: {} })).rejects.toThrow("model list");
		await expect(discoverProviderModels({ providerId: "missing", modelsPath, auth: {} })).rejects.toThrow("missing");
		expect(existsSync(`${modelsPath}.backup`)).toBe(false);
	});
});
