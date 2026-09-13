import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { bakeoff } from "../../packages/agent/test/harness/fixtures/read-summary/bakeoff.ts";
import { invalidCases } from "../../packages/agent/test/harness/fixtures/read-summary/invalid-cases.ts";

const { values } = parseArgs({ options: { case: { type: "string" }, out: { type: "string" } }, strict: true });
const out = values.out;
if (!out || !isAbsolute(out)) throw new Error("--out must be an absolute path");
mkdirSync(dirname(out), { recursive: true });
const startedAt = new Date().toISOString();
try {
	switch (values.case) {
		case "bakeoff": {
			const input = process.env.OMP_BAKEOFF_INPUT;
			const manifestHash = process.env.OMP_BAKEOFF_CORPUS_SHA256;
			const omp = process.env.OMP_BAKEOFF_REFERENCE;
			if (!input || !manifestHash || !omp) throw new Error("Execution-owned input, frozen manifest SHA and omp copy are required: OMP_BAKEOFF_INPUT, OMP_BAKEOFF_CORPUS_SHA256, OMP_BAKEOFF_REFERENCE");
			const result = await bakeoff({ input, manifestHash, omp, out });
			console.log(JSON.stringify({ status: result.status, languages: result.languages, out }));
			break;
		}
		case "bakeoff-invalid": {
			const result = invalidCases();
			writeFileSync(out, `${JSON.stringify({ ...result, head_sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), startedAt, finishedAt: new Date().toISOString(), command: process.argv, cwd: process.cwd() }, null, 2)}\n`);
			if (!result.pass) throw new Error("Negative gate accepted invalid measurement");
			console.log(JSON.stringify({ pass: result.pass, cases: result.cases.length, out }));
			break;
		}
		default: throw new Error("--case must be bakeoff or bakeoff-invalid");
	}
} catch (error) {
	writeFileSync(`${out}.error.json`, `${JSON.stringify({ status: "inconclusive", adoptable: false, startedAt, finishedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
	throw error;
}
