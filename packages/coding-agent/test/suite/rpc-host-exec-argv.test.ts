import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { defaultHostLaunch } from "../../src/modes/rpc/host-launch.ts";
import { INTERNAL_SUPERVISOR_FLAG, resolveHostChildLaunch } from "../../src/modes/rpc/host-lifecycle.ts";

const originalExecArgv = process.execArgv;
afterEach(() => {
	process.execArgv = originalExecArgv;
});

const cases: { name: string; input: string[]; expected: string[] }[] = [
	{ name: "short eval", input: ["-e", "startHost()"], expected: [] },
	{ name: "long eval", input: ["--eval", "startHost()"], expected: [] },
	{ name: "equals eval", input: ["--eval=startHost()"], expected: [] },
	{ name: "short print", input: ["-p", "startHost()"], expected: [] },
	{ name: "long print", input: ["--print", "startHost()"], expected: [] },
	{ name: "equals print", input: ["--print=startHost()"], expected: [] },
	{ name: "print eval", input: ["-pe", "startHost()"], expected: [] },
	{ name: "eval print", input: ["-ep", "startHost()"], expected: [] },
	{ name: "separate print eval", input: ["-p", "-e", "startHost()"], expected: [] },
	{ name: "print without expression", input: ["--print", "--trace-warnings"], expected: ["--trace-warnings"] },
	{ name: "module input", input: ["--input-type", "module", "-e", "startHost()"], expected: [] },
	{ name: "underscore input", input: ["--input_type", "module", "-e", "startHost()"], expected: [] },
	{ name: "underscore equals input", input: ["--input_type=module", "-e", "startHost()"], expected: [] },
	{ name: "equals input", input: ["--input-type=module", "--eval=startHost()"], expected: [] },
	{ name: "interactive", input: ["-i", "--interactive", "--interactive=true"], expected: [] },
	{ name: "empty", input: [], expected: [] },
	{
		name: "loaders and runtime flags",
		input: ["--import", "tsx", "--require=./preload.cjs", "--max-old-space-size=512", "-e", "startHost()"],
		expected: ["--import", "tsx", "--require=./preload.cjs", "--max-old-space-size=512"],
	},
	{
		name: "single dash V8 flags",
		input: ["-predictable", "-print-bytecode", "-expose-gc", "--eval=0"],
		expected: ["-predictable", "-print-bytecode", "-expose-gc"],
	},
	{
		name: "print before runtime flag and equals eval",
		input: ["--print", "--trace-warnings", "--eval=startHost()"],
		expected: ["--trace-warnings"],
	},
];

const supervisorArgs = ["--socket", "public.sock"];
const host = { socket: "public.sock", hostArgs: ["--provider", "mock"] };

describe("RPC host runtime arguments", () => {
	it.each(cases)("filters $name at both spawn levels without mutating the caller", ({ input, expected }) => {
		process.execArgv = [...input];
		const sibling = defaultHostLaunch(supervisorArgs, false, "supervisor.js");
		expect(sibling.args).toEqual([...expected, "supervisor.js", ...supervisorArgs]);

		const bundled = defaultHostLaunch(supervisorArgs, false, null);
		expect(bundled.args.slice(0, expected.length)).toEqual(expected);
		expect(bundled.args.slice(expected.length + 1)).toEqual([INTERNAL_SUPERVISOR_FLAG, ...supervisorArgs]);

		const child = resolveHostChildLaunch(host, "internal.sock", false);
		expect(child.args.slice(0, expected.length)).toEqual(expected);
		expect(child.args.slice(expected.length + 1)).toEqual([
			"--mode",
			"rpc",
			"--multi-session",
			"--listen",
			"unix://internal.sock",
			...host.hostArgs,
		]);
		expect(process.execArgv).toEqual(input);
	});

	it("leaves compiled and explicit command launches unchanged", () => {
		process.execArgv = ["-e", "startHost()"];
		expect(defaultHostLaunch(supervisorArgs, true).args).toEqual([INTERNAL_SUPERVISOR_FLAG, ...supervisorArgs]);
		expect(resolveHostChildLaunch(host, "internal.sock", true).args).toEqual([
			"--mode",
			"rpc",
			"--multi-session",
			"--listen",
			"unix://internal.sock",
			...host.hostArgs,
		]);
		expect(
			resolveHostChildLaunch(
				{ ...host, childCommand: "wrapper", childArgs: ["--eval", "owned()"] },
				"internal.sock",
				false,
			),
		).toEqual({
			command: "wrapper",
			args: ["--eval", "owned()", "--listen", "unix://internal.sock"],
		});
	});
});

describe("real Node eval callers", () => {
	it.each(["-e", "--eval", "-p", "-pe", "--input-type=module", "--input_type=module"])(
		"executes the child entry instead of replaying %s",
		(flag) => {
			const dir = mkdtempSync(join(tmpdir(), "senpi-exec-argv-"));
			try {
				const entry = join(dir, "entry.mjs");
				writeFileSync(entry, 'console.log("HOST_ENTRY_REACHED")');
				const launchModule = fileURLToPath(new URL("../../src/modes/rpc/host-launch.ts", import.meta.url));
				// A replay exits immediately: even on the broken code this can spawn only one child.
				const isModule = flag.includes("module");
				const prefix = isModule
					? 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'
					: "";
				const code = `${prefix}
if (process.env.SENPI_EXEC_ARGV_CHILD === '1') {
  console.log('CALLER_REPLAYED');
} else {
  const { defaultHostLaunch } = require(${JSON.stringify(launchModule)});
  const { spawnSync } = require('node:child_process');
  const launch = defaultHostLaunch([], false, ${JSON.stringify(entry)});
  const child = spawnSync(launch.command, launch.args, {
    encoding: 'utf8', timeout: 10000,
    env: { ...process.env, SENPI_EXEC_ARGV_CHILD: '1' }
  });
  process.stdout.write(child.stdout || '');
  process.stderr.write(child.stderr || '');
  process.exitCode = child.status ?? 1;
}`;
				const result = spawnSync(process.execPath, ["--import", "tsx", flag, ...(isModule ? ["-e"] : []), code], {
					encoding: "utf8",
					timeout: 15_000,
					env: { ...process.env, SENPI_CODING_AGENT_DIR: dir },
				});
				expect(result.error).toBeUndefined();
				expect(result.status, result.stderr).toBe(0);
				expect(result.stdout).toContain("HOST_ENTRY_REACHED");
				expect(result.stdout).not.toContain("CALLER_REPLAYED");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});
