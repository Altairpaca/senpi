import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createPermissionP0Host } from "./permission-p0-host.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0).reverse()) await dispose();
});

type Setup = Parameters<typeof createPermissionP0Host>[3];

async function overwriteOutside(setup: Setup, preset: string | undefined) {
	const host = await createPermissionP0Host([], undefined, [], setup);
	disposers.push(host.dispose);
	const original = await readFile(host.outsidePath, "utf8");
	const result = await host.run(preset, { name: "write", args: { path: host.outsidePath, content: "overwritten" } });
	return { result, original, after: await readFile(host.outsidePath, "utf8") };
}

describe("a broken permission setup fails closed (#2617)", () => {
	it.each([
		["a misspelled preset in the global settings", { globalSettings: { permissionPreset: "workspce" } }, "ask"],
		["a non-string preset in the global settings", { globalSettings: { permissionPreset: 5 } }, "ask"],
		["a misspelled preset in the project settings", { projectSettings: { permissionPreset: "workspce" } }, "ask"],
		["a misspelled preset on the command line", { presetFlag: "workspce" }, undefined],
		["a misspelled preset sent per session over RPC", undefined, "workspce"],
	] as const)("refuses tool calls for %s instead of running them unchecked", async (_label, setup, preset) => {
		// Given a setting the engine cannot accept, and a client that denies any prompt.
		// When the agent tries to overwrite a file outside the project.
		const { result, original, after } = await overwriteOutside(setup, preset);
		// Then the call is refused with the reason, and the file is untouched.
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.result)).toContain("Permission setup failed");
		expect(after).toBe(original);
	});

	it.each(["workspace", "accept-edits", "read-only", "ask"])(
		"keeps checking normally with the valid preset %s",
		async (preset) => {
			// Given a valid stricter preset.
			// When the agent tries the same outside write.
			const { result, original, after } = await overwriteOutside(undefined, preset);
			// Then it is asked (and denied) through the normal path, not refused as broken.
			expect(result.approvals.length).toBeGreaterThan(0);
			expect(JSON.stringify(result.result)).not.toContain("Permission setup failed");
			expect(after).toBe(original);
		},
	);

	it("does not run a shell command when the project settings misspell full-access", async () => {
		// Given a project settings typo of the most permissive preset.
		const host = await createPermissionP0Host([], undefined, [], {
			projectSettings: { permissionPreset: "full-acess" },
		});
		disposers.push(host.dispose);
		// When the agent runs a shell command.
		const result = await host.run("full-access", { name: "bash", args: { command: "echo should-not-run" } });
		// Then it does not run.
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.result)).toContain("Permission setup failed");
	});
});
