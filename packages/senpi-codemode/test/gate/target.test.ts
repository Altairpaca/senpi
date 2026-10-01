import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { recordTargetBuild } from "../../scripts/gate-build-inputs.ts";
import { runProcess } from "../../scripts/gate-process.ts";
import { assertFreshTarget } from "../../scripts/gate-target.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

it("refuses to measure a target whose workspace dist predates its sources", async () => {
	// Given: a target with old AI output and newer source, independent of wall-clock timing.
	const root = await mkdtemp(join(tmpdir(), "senpi-gate-stale-"));
	try {
		const workspace = join(root, "packages/ai");
		await mkdir(join(workspace, "src"), { recursive: true });
		await mkdir(join(workspace, "dist"));
		await mkdir(join(root, "packages/senpi-codemode"));
		await writeFile(join(workspace, "package.json"), '{"name":"@earendil-works/pi-ai","main":"./dist/index.js"}');
		await utimes(join(workspace, "package.json"), 100, 100);
		await writeFile(join(workspace, "src/index.ts"), "export const model = 'current';");
		await writeFile(join(workspace, "dist/index.js"), "export const model = 'obsolete';");
		await utimes(join(workspace, "dist/index.js"), 100, 100);
		await utimes(join(workspace, "src/index.ts"), 200, 200);
		// When: the real gate is asked to record this target as the baseline.
		const result = await runProcess(
			["bun", "scripts/gate-eval.ts", "--target", root, "--write-baseline"],
			packageRoot,
		);
		// Then: it rejects the stale package before measurement, rather than certifying its old graph.
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("stale workspace dist: packages/ai");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 180_000);

it("allows workspace output rebuilt after its source changed", async () => {
	// Given: an entry built after every input in the target workspace.
	const root = await mkdtemp(join(tmpdir(), "senpi-gate-fresh-"));
	try {
		const workspace = join(root, "packages/ai");
		await mkdir(join(workspace, "src"), { recursive: true });
		await mkdir(join(workspace, "dist"));
		await writeFile(join(workspace, "package.json"), '{"main":"./dist/index.js"}');
		await writeFile(join(workspace, "src/index.ts"), "export const model = 'current';");
		await writeFile(join(workspace, "dist/index.js"), "export const model = 'current';");
		await utimes(join(workspace, "package.json"), 100, 100);
		await utimes(join(workspace, "src/index.ts"), 200, 200);
		await utimes(join(workspace, "dist/index.js"), 300, 300);
		await recordTargetBuild(join(root, "packages/senpi-codemode"));
		// When: the gate checks the freshly built target.
		const measured = assertFreshTarget(join(root, "packages/senpi-codemode"));
		// Then: it permits measurement instead of rejecting a valid rebuild.
		await expect(measured).resolves.toBeUndefined();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("rejects a deleted source even when every remaining input predates the build", async () => {
	// Given: build evidence names a source no longer present in the checkout.
	const root = await mkdtemp(join(tmpdir(), "senpi-gate-deleted-"));
	try {
		const workspace = join(root, "packages/ai");
		await mkdir(join(workspace, "src"), { recursive: true });
		await mkdir(join(workspace, "dist"));
		await writeFile(join(workspace, "package.json"), '{"main":"./dist/index.js"}');
		await writeFile(join(workspace, "src/index.ts"), "export const model = 1;");
		await writeFile(join(workspace, "dist/index.js"), "export const model = 1;");
		await writeFile(join(workspace, "src/deleted.ts"), "export const removed = 2;");
		await utimes(join(workspace, "package.json"), 100, 100);
		await utimes(join(workspace, "src/index.ts"), 100, 100);
		await utimes(join(workspace, "src/deleted.ts"), 100, 100);
		await utimes(join(workspace, "dist/index.js"), 200, 200);
		await recordTargetBuild(join(root, "packages/senpi-codemode"));
		await rm(join(workspace, "src/deleted.ts"));
		// When / Then: mtime equality cannot certify a deleted module.
		await expect(assertFreshTarget(join(root, "packages/senpi-codemode"))).rejects.toThrow(
			"changed or deleted inputs: src/deleted.ts",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
