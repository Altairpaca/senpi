import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { measurePolicies } from "../../scripts/gate-policy.ts";

describe("load-invariant policy measurement", () => {
	it.each(["js", "py", "rb", "jl"])(
		"records %s evictions when terminal history exceeds capacity",
		async (language) => {
			// Given
			const target = fileURLToPath(new URL("../..", import.meta.url));
			// When
			const invariants = await measurePolicies(target);
			// Then
			expect(invariants[`${language}/retentionPolicy`]).toEqual({
				retained: 32,
				evicted: 8,
				first: "retained-8",
				last: "retained-39",
				live: 0,
			});
		},
	);

	it.each(["js", "py", "rb", "jl"])("records %s notices when memory crosses policy thresholds", async (language) => {
		// Given
		const target = fileURLToPath(new URL("../..", import.meta.url));
		// When
		const invariants = await measurePolicies(target);
		// Then
		const collects = language === "js" || language === "py";
		expect(invariants[`${language}/memoryPolicy`]).toEqual({
			noticeCount: collects ? 3 : 1,
			globalNames: collects ? ["rows"] : [],
			ceilingMarks: collects ? 1 : 2,
			pendingAfterBreach: true,
			recycledResults: 1,
			pendingAfterRecycle: false,
			uncollectedOverCeiling: !collects,
			uncollectedPending: !collects,
		});
	});
});
