import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { compareReports } from "./gate-compare.ts";
import { runProcess } from "./gate-process.ts";
import { measurePolicies } from "./gate-policy.ts";
import {
	allowlistSchema, canonical, GateInputError, type GateReport, goldenSchema, readReport, runtimesSchema,
} from "./gate-report.ts";
import { measureSuite } from "./gate-suite.ts";
import { measureSurfaces } from "./gate-surfaces.ts";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptRoot, "..");
const runtimeReportSchema = Type.Object({
	helperNames: Type.Array(Type.String()),
	witnesses: Type.Record(Type.String(), Type.Unknown()),
	hostRuntime: Type.Union([Type.Literal("bun"), Type.Literal("node")]),
	memory: Type.Optional(Type.Unknown()),
	cleanup: Type.Object({ kernelClosed: Type.Boolean(), bridgeClosed: Type.Boolean() }),
});
const importsSchema = Type.Object({
	extension: Type.Array(Type.String()),
	firstKernel: Type.Array(Type.String()),
	sizes: Type.Record(Type.String(), Type.Number()),
});

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			baseline: { type: "string", default: "test/gate/baseline.json" },
			target: { type: "string", default: packageRoot },
			report: { type: "string", default: "gate-report.json" },
			"write-baseline": { type: "boolean", default: false },
		},
	});
	const requestedTarget = resolve(values.target);
	const target = requestedTarget.endsWith("senpi-codemode") ? requestedTarget : resolve(requestedTarget, "packages/senpi-codemode");
	const manifest: unknown = JSON.parse(await readFile(resolve(packageRoot, "test/gate/runtimes.json"), "utf8"));
	const golden: unknown = JSON.parse(await readFile(resolve(packageRoot, "test/gate/helpers.golden.json"), "utf8"));
	const allowlist: unknown = JSON.parse(await readFile(resolve(packageRoot, "test/gate/allowlist.json"), "utf8"));
	if (!Check(runtimesSchema, manifest) || !Check(goldenSchema, golden) || !Check(allowlistSchema, allowlist))
		throw new GateInputError("runtime manifest, helper golden or allowlist");
	const report: GateReport = {
		version: 1, ...(await measureSurfaces(target)), helperCensus: {}, runtimes: [],
		invariants: await measurePolicies(target), imports: {},
	};
	const failures: string[] = [];
	const observations: Record<string, unknown> = {};
	report.observations = observations;
	const revision = await runProcess(["git", "rev-parse", "HEAD"], target);
	if (revision.exitCode !== 0) throw new GateInputError("target checkout revision");
	observations.targetRevision = revision.stdout.trim();
	for (const runtime of manifest.required) {
		const command = runtime.jsRuntime ?? { js: "bun", py: "python3", rb: "ruby", jl: "julia" }[runtime.language];
		const version = await runProcess([command, "--version"], target).catch((error: unknown) => {
			if (error instanceof Error && "code" in error && error.code === "ENOENT")
				return { exitCode: 1, stdout: "", stderr: error.message };
			throw error;
		});
		const available = version.exitCode === 0;
		observations[`${runtime.id}/version`] = version.stdout.trim();
		report.runtimes.push({ id: runtime.id, available });
		if (!available) {
			failures.push(`required interpreter missing: ${runtime.id}`);
			continue;
		}
		const host = runtime.jsRuntime ?? "bun";
		const probe = await runProcess([
			host, ...(host === "node" ? ["--import", "tsx"] : []),
			resolve(scriptRoot, "gate-runtime.ts"), target, runtime.language,
			resolve(packageRoot, "test/gate/helpers.golden.json"),
		], packageRoot);
		const line = probe.stdout.split("\n").find((entry) => entry.startsWith("GATE_RUNTIME:"));
		if (probe.exitCode !== 0 || !line) {
			failures.push(`runtime ${runtime.id} failed: ${probe.stderr || probe.stdout}`);
			continue;
		}
		const measured: unknown = JSON.parse(line.slice("GATE_RUNTIME:".length));
		if (!Check(runtimeReportSchema, measured)) throw new GateInputError(`runtime ${runtime.id} report`);
		if (runtime.jsRuntime !== undefined && measured.hostRuntime !== runtime.jsRuntime)
			failures.push(`required interpreter mismatch: ${runtime.id} ran ${measured.hostRuntime}`);
		observations[`${runtime.id}/memoryAfter50Cells`] = measured.memory;
		const names = measured.helperNames.sort();
		report.helperCensus[runtime.id] = names;
		if (runtime.id === "js-bun") report.helperCensus.js = names;
		for (const name of golden[runtime.language] ?? []) {
			if (!names.includes(name)) failures.push(`helper census: ${runtime.language} removed [${name}]`);
		}
		for (const [scenario, witness] of Object.entries(measured.witnesses))
			report.invariants[`${runtime.id}/${scenario}`] = witness;
		report.invariants[`${runtime.id}/cleanup`] = measured.cleanup;
	}
	if (process.env.SENPI_CODEMODE_GATE_MUTATE === "drop-phase") {
		report.helperCensus.js = (report.helperCensus.js ?? []).filter((name) => name !== "phase");
	}
	if (failures.length === 0) {
		const census = await runProcess([
			"node", "--import", "tsx", "--import", resolve(scriptRoot, "gate-import-observer.ts"),
			resolve(scriptRoot, "gate-imports.ts"), target,
		], packageRoot);
		const line = census.stdout.split("\n").find((entry) => entry.startsWith("GATE_IMPORTS:"));
		if (census.exitCode !== 0 || !line) failures.push(`import census failed: ${census.stderr || census.stdout}`);
		else {
			const measured: unknown = JSON.parse(line.slice("GATE_IMPORTS:".length));
			if (!Check(importsSchema, measured)) throw new GateInputError("import census report");
			report.imports = { extension: measured.extension, firstKernel: measured.firstKernel };
			observations.importBytes = measured.sizes;
		}
		// OS-specific contracts may legitimately skip on another OS. Their real outcomes
		// remain visible; the suite's exit status gates every active contract independently.
		observations.legacyContracts = await measureSuite(target, resolve(packageRoot, "../../node_modules/vitest/vitest.mjs"))
			.catch((error: unknown) => {
				if (!(error instanceof GateInputError)) throw error;
				failures.push(error.message);
				return {};
			});
	}
	const result = values["write-baseline"]
		? { exitCode: failures.length ? 1 : 0, failures: [], additions: [] }
		: compareReports({
				baseline: await readReport(resolve(values.baseline)), report,
				additions: Object.values(allowlist.nodes).flatMap((node) => node.additions),
			});
	failures.push(...result.failures);
	await writeFile(resolve(values.report), `${JSON.stringify({ report, failures, additions: result.additions }, null, 2)}\n`);
	if (values["write-baseline"] && failures.length === 0)
		await writeFile(resolve(values.baseline), `${JSON.stringify(report, null, 2)}\n`);
	console.log(`Gate report: ${resolve(values.report)}`);
	for (const failure of new Set(failures)) console.error(failure);
	console.log(`gate: ${failures.length ? "FAIL" : "PASS"} (${Object.keys(report.prompts).length} prompt cells, ${report.runtimes.length} runtimes)`);
	process.exitCode = failures.length ? 1 : 0;
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : canonical(error));
	process.exitCode = 1;
});
