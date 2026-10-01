import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { cleanupSchema } from "../../scripts/gate-resources.ts";
import { runChild } from "../eval/child-probe.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const runtimeSchema = Type.Object({ cleanup: cleanupSchema });

it.each([false, true])(
	"observes the real Bun kernel after close when leaked=%s",
	async (leaked) => {
		// Given: the real runtime's named builtin imports, not a fixture using the patched default export.
		const env = { ...process.env };
		if (leaked) env.SENPI_CODEMODE_GATE_MUTATE = "leak-kernel";
		else delete env.SENPI_CODEMODE_GATE_MUTATE;
		// When: the real probe closes its kernel or deliberately leaves it alive until finally.
		const result = await runChild({
			command: "bun",
			args: [
				resolve(packageRoot, "scripts/gate-runtime.ts"),
				packageRoot,
				"js",
				resolve(packageRoot, "test/gate/helpers.golden.json"),
			],
			cwd: packageRoot,
			env,
		});
		// Then: actual lifecycle state, not constructor-export patchability, controls the witness.
		expect(result.code, result.stderr).toBe(0);
		const line = result.stdout.split("\n").find((entry) => entry.startsWith("GATE_RUNTIME:"));
		if (!line) throw new TypeError("Missing runtime resource report");
		const report: unknown = JSON.parse(line.slice("GATE_RUNTIME:".length));
		if (!Check(runtimeSchema, report)) throw new TypeError("Invalid runtime resource report");
		if (leaked) expect(report.cleanup.workers).toBeGreaterThan(0);
		else expect(Object.values(report.cleanup).every((count) => count === 0)).toBe(true);
	},
	240_000,
);
