import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { createEvalInputSchema } from "../src/tool/types.ts";

// senpi#2240: Mistral-hosted GLM needs branch-local field definitions for complete calls.
describe("eval action schemas", () => {
	const schema = createEvalInputSchema({ js: true, py: true, rb: false, jl: false });
	const run = { language: "py", code: "print(2 + 2)", summary: "Calculate four." };

	it("requires every run field with an explicit or omitted action", () => {
		for (const action of [{ action: "run" }, {}]) {
			expect(Check(schema, { ...run, ...action })).toBe(true);
			expect(Check(schema, action)).toBe(false);
			for (const field of Object.keys(run)) {
				const incomplete = Object.fromEntries(Object.entries(run).filter(([name]) => name !== field));
				expect(Check(schema, { ...incomplete, ...action })).toBe(false);
			}
		}
	});

	it("keeps list, peek and stop usable without run fields", () => {
		expect(Check(schema, { action: "list" })).toBe(true);
		for (const action of ["peek", "stop"]) {
			expect(Check(schema, { action, cell_id: "cell-1" })).toBe(true);
			expect(Check(schema, { action })).toBe(false);
			expect(Check(schema, { action, cell_id: "" })).toBe(false);
		}
		expect(Check(schema, { ...run, action: "unknown" })).toBe(false);
		expect(Check(schema, { ...run, language: "rb" })).toBe(false);
	});

	it("declares every required field inside the branch that requires it", () => {
		const wire: { anyOf?: { properties?: Record<string, unknown>; required?: string[] }[] } = JSON.parse(
			JSON.stringify(schema),
		);
		expect(wire.anyOf).toBeDefined();
		for (const branch of wire.anyOf ?? []) {
			for (const field of branch.required ?? []) {
				expect(branch.properties).toHaveProperty(field);
			}
		}
	});
});
