import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonical } from "../../scripts/gate-report.ts";
import { measureSurfaces } from "../../scripts/gate-surfaces.ts";

describe("regression surface matrix", () => {
	it("covers every dialect and capability cell when measuring the real prompt builder", async () => {
		// Given
		const target = fileURLToPath(new URL("../..", import.meta.url));
		// When
		const surfaces = await measureSurfaces(target);
		// Then: the coverage keys, not prose wording, are the contract.
		expect(Object.keys(surfaces.prompts)).toHaveLength(240);
		expect(Object.keys(surfaces.schemas)).toEqual(expect.arrayContaining(["js", "js+py", "all"]));
		expect(surfaces.prompts["gpt/true/true/all/bun"]).toBeDefined();
		expect(surfaces.prompts["default/false/false/js/node"]).toBeDefined();
		expect(surfaces.prompts["gpt/true/true/all/bun/host"]).toBeDefined();
	});

	it("preserves character content while ignoring JSON object insertion order", () => {
		// Given
		const input = { second: ["abc"], first: 1 };
		// When
		const value = canonical(input);
		// Then
		expect(value).toBe(canonical({ first: 1, second: ["abc"] }));
		expect(value).not.toBe(canonical({ first: 1, second: ["abd"] }));
	});
});
