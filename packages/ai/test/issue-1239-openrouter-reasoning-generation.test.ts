import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("issue #1239 OpenRouter reasoning catalog generation", () => {
	it("derives mandatory reasoning controls from OpenRouter model metadata", () => {
		const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-openrouter-reasoning-generation-"));
		temporaryRoots.push(fixtureRoot);
		const isolatedPackageRoot = join(fixtureRoot, "package");
		mkdirSync(isolatedPackageRoot);
		for (const entry of ["package.json", "scripts", "src"]) {
			cpSync(join(packageRoot, entry), join(isolatedPackageRoot, entry), { recursive: true });
		}

		const outputDir = join(fixtureRoot, "output");
		const preloadPath = join(fixtureRoot, "mock-models.mjs");
		const openRouterModel = {
			id: "z-ai/glm-5.3",
			name: "GLM 5.3",
			supported_parameters: ["tools", "reasoning"],
			architecture: { modality: "text->text" },
			pricing: {
				prompt: "0.0000006",
				completion: "0.0000019",
				input_cache_read: "0.000000119",
				input_cache_write: "0",
			},
			context_length: 200000,
			top_provider: { context_length: 200000, max_completion_tokens: 131072 },
			reasoning: {
				mandatory: true,
				supported_efforts: ["max", "high", "low"],
				default_effort: "max",
			},
		};

		writeFileSync(
			preloadPath,
			`const openRouterModel = ${JSON.stringify(openRouterModel)};\n` +
				`globalThis.fetch = async (input) => {\n` +
				`  const url = String(input);\n` +
				`  if (url === "https://models.dev/api.json") return new Response(JSON.stringify({}), { status: 200 });\n` +
				`  if (url === "https://openrouter.ai/api/v1/models") return new Response(JSON.stringify({ data: [openRouterModel] }), { status: 200 });\n` +
				`  if (url === "https://ai-gateway.vercel.sh/v1/models") return new Response(JSON.stringify({ data: [] }), { status: 200 });\n` +
				`  if (url === "https://apis.opengateway.ai/v1/models") return new Response(JSON.stringify({ data: [] }), { status: 200 });\n` +
				`  throw new Error(\`Unexpected fetch: \${url}\`);\n` +
				`};\n`,
		);

		const result = spawnSync(
			process.execPath,
			[
				"--import",
				pathToFileURL(preloadPath).href,
				"scripts/generate-models.ts",
				"--json-only",
				"--json-output",
				outputDir,
			],
			{ cwd: isolatedPackageRoot, encoding: "utf8", timeout: 10_000 },
		);

		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		const generated = JSON.parse(readFileSync(join(outputDir, "providers", "openrouter.json"), "utf8"));
		expect(generated[openRouterModel.id]?.reasoning).toBe(true);
		expect(generated[openRouterModel.id]?.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		});
	});
});
