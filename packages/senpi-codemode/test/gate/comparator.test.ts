import { describe, expect, it } from "vitest";
import { compareReports } from "../../scripts/gate-compare.ts";
import type { GateReport } from "../../scripts/gate-report.ts";

const baseline: GateReport = {
	version: 1,
	prompts: {
		fixture: { description: "abc", promptSnippet: "cell", promptGuidelines: ["batch"], bytes: 12, tokens: 3 },
	},
	schemas: { js: '{"type":"object"}' },
	helperCensus: { js: ["phase", "print"] },
	runtimes: [
		{ id: "js-bun", available: true },
		{ id: "rb", available: true },
	],
	invariants: { terminalEvents: 1 },
	imports: { extension: ["node:fs"] },
};

describe("eval regression report comparison", () => {
	it("reports every regression when helpers, prompt bytes and a required runtime change", () => {
		// Given: three independent regressions in one report.
		const changed: GateReport = {
			...baseline,
			helperCensus: { js: ["print"] },
			prompts: { fixture: { ...baseline.prompts.fixture, description: "abd" } },
			runtimes: [
				{ id: "js-bun", available: true },
				{ id: "rb", available: false },
			],
		};
		// When
		const result = compareReports({ baseline, report: changed, additions: [] });
		// Then
		expect(result.exitCode).toBe(1);
		expect(result.failures).toEqual([
			"required interpreter missing: rb",
			"helper census: js removed [phase]",
			"prompt surface: fixture changed",
		]);
	});

	it("accepts an identical report", () => {
		// Given / When
		const result = compareReports({ baseline, report: structuredClone(baseline), additions: [] });
		// Then
		expect(result).toEqual({ exitCode: 0, failures: [], additions: [] });
	});

	it("rejects unreviewed additions and never allowlists a removal", () => {
		// Given
		const changed = { ...baseline, helperCensus: { js: ["print", "wait"] } };
		// When
		const result = compareReports({ baseline, report: changed, additions: ["helperCensus/js/wait"] });
		// Then
		expect(result.failures).toEqual(["helper census: js removed [phase]"]);
		expect(result.additions).toEqual(["helperCensus/js/wait"]);
	});

	it("rejects a missing report section instead of treating it as an additive change", () => {
		// Given
		const changed = { ...baseline, schemas: {} };
		// When
		const result = compareReports({ baseline, report: changed, additions: ["schemas/js"] });
		// Then
		expect(result.failures).toContain("schema surface: js removed");
	});
});
