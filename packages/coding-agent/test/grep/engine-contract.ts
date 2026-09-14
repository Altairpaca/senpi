import { describe, expect, it } from "vitest";
import type { GrepEngine } from "../../src/core/tools/grep/engine.ts";

export function describeEngineContract(name: string, makeEngine: () => Promise<GrepEngine> | GrepEngine): void {
	describe(`${name} GrepEngine contract`, () => {
		it("exposes the selected engine name", async () => {
			const engine = await makeEngine();
			expect(engine.name).toBe(name);
		});
	});
}
