import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { runProcess } from "../../scripts/gate-process.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scripts = join(packageRoot, "scripts");
const reportSchema = Type.Object({
	extension: Type.Array(Type.String()),
	firstKernel: Type.Array(Type.String()),
	sizes: Type.Record(Type.String(), Type.Number()),
});

async function createTarget(root: string): Promise<string> {
	const target = join(root, "packages/senpi-codemode");
	await mkdir(join(target, "src/extension"), { recursive: true });
	await mkdir(join(target, "src/config"), { recursive: true });
	await mkdir(join(target, "src/interpreters"), { recursive: true });
	await writeFile(join(root, "package.json"), '{"type":"module"}');
	await writeFile(
		join(target, "src/index.ts"),
		'import { Type } from "typebox"; export const schema = Type.String();',
	);
	await writeFile(join(target, "src/config/settings.ts"), "export const defaultCodemodeSettings = {};");
	await writeFile(
		join(target, "src/interpreters/detect.ts"),
		"export const createInterpreterDetector = () => ({}); export const getInterpreterAvailability = async () => ({});",
	);
	await writeFile(
		join(target, "src/extension/worker.ts"),
		'import { parentPort } from "node:worker_threads"; import { basename } from "node:path"; parentPort.postMessage(basename("/fixture/ready"));',
	);
	await writeFile(
		join(target, "src/extension/session-manager.ts"),
		`
import { Worker } from "node:worker_threads";
import { once } from "node:events";
export async function createCodemodeSessionManager() {
	let worker;
	return {
		getKernel: async () => ({
			run: async () => {
				worker = new Worker(new URL("./worker.ts", import.meta.url));
				await once(worker, "message");
				return { ok: true };
			},
		}),
		dispose: async () => { await worker?.terminate(); },
	};
}`,
	);
	return target;
}

async function census(target: string) {
	const result = await runProcess(
		[
			"node",
			"--import",
			"tsx",
			"--import",
			join(scripts, "gate-import-observer.ts"),
			join(scripts, "gate-imports.ts"),
			target,
		],
		packageRoot,
	);
	expect(result.exitCode, result.stderr).toBe(0);
	const line = result.stdout.split("\n").find((entry) => entry.startsWith("GATE_IMPORTS:"));
	if (line === undefined) throw new TypeError("Import census produced no report");
	const report: unknown = JSON.parse(line.slice("GATE_IMPORTS:".length));
	if (!Check(reportSchema, report)) throw new TypeError("Import census produced an invalid report");
	return report;
}

describe("cold eager import census", () => {
	it("counts transitive dependencies equally when the target shares or isolates the harness dependency tree", async () => {
		// Given: identical targets, one sharing the harness dependency cache and one isolated.
		const root = await mkdtemp(join(tmpdir(), "senpi-census-cold-"));
		try {
			const shared = await createTarget(join(root, "shared"));
			const isolated = await createTarget(join(root, "isolated"));
			const dependencies = resolve(packageRoot, "../../node_modules");
			await symlink(dependencies, join(root, "shared/node_modules"), "junction");
			await mkdir(join(root, "isolated/node_modules"), { recursive: true });
			await cp(join(dependencies, "typebox"), join(root, "isolated/node_modules/typebox"), { recursive: true });
			// When: the real probe measures both targets in fresh processes.
			const sharedReport = await census(shared);
			const isolatedReport = await census(isolated);
			// Then: checkout ownership cannot hide the actual transitive module graph.
			expect(sharedReport.extension).toContain("node_modules/typebox/build/type/types/index.mjs");
			expect(sharedReport.extension).toEqual(isolatedReport.extension);
			expect(sharedReport.firstKernel).toEqual(isolatedReport.firstKernel);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 180_000);
});
