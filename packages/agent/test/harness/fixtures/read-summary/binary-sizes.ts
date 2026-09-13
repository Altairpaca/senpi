import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./scorer.ts";

export function measurePrototypeBinary(out: string) {
	const scratch = join(out, "compile");
	mkdirSync(scratch, { recursive: true });
	const common = 'import {readFileSync} from "node:fs"; const text=readFileSync(process.argv[2],"utf8");';
	writeFileSync(join(scratch, "raw.ts"), `${common}\nconsole.log(text);\n`);
	writeFileSync(
		join(scratch, "candidate.ts"),
		`import {heuristic} from ${JSON.stringify(fileURLToPath(new URL("./heuristic.ts", import.meta.url)))};\n${common}\nconsole.log(heuristic(text,process.argv[3]).text);\n`,
	);
	const commands: { command: string[]; startedAt: string; finishedAt: string; exitCode: number; output: string }[] =
		[];
	const sizes: Record<string, { bytes: number; sha256: string }> = {};
	for (const name of ["raw", "candidate"]) {
		const args = [
			"build",
			"--compile",
			"--minify",
			"--keep-names",
			"--no-compile-autoload-dotenv",
			"--no-compile-autoload-bunfig",
			join(scratch, `${name}.ts`),
			"--outfile",
			join(scratch, name),
		];
		const startedAt = new Date().toISOString();
		const output = execFileSync(process.execPath, args, { encoding: "utf8", timeout: 120000 });
		commands.push({
			command: [process.execPath, ...args],
			startedAt,
			finishedAt: new Date().toISOString(),
			exitCode: 0,
			output,
		});
		sizes[name] = { bytes: statSync(join(scratch, name)).size, sha256: sha256(readFileSync(join(scratch, name))) };
	}
	return {
		scope: "standalone prototype pair, not a production senpi binary claim",
		sizes,
		prototype_delta_bytes: sizes.candidate.bytes - sizes.raw.bytes,
		embedded_runtime_grammar_delta_bytes: 0,
		max_embedded_delta_bytes: 12582912,
		wasm_enabled: false,
		wasm_initialization_count: 0,
		native_reference_distributed: false,
		commands,
	};
}
