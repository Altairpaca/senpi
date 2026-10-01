import { type ChildProcess, spawn } from "node:child_process";

export type ChildResult = {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly pid: number;
};

/** Close drains both pipes; the watchdog guards a hang, never child startup speed. */
export function collectChild(child: ChildProcess): Promise<ChildResult> {
	const pid = child.pid;
	if (pid === undefined) throw new TypeError("Child probe did not spawn");
	let stdout = "";
	let stderr = "";
	child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk;
	});
	return new Promise((resolve, reject) => {
		const watchdog = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new TypeError("Child probe hung without closing"));
		}, 180_000);
		child.once("error", (error) => {
			clearTimeout(watchdog);
			reject(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(watchdog);
			resolve({ code, signal, stdout, stderr, pid });
		});
	});
}

export function runChild(input: {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env?: NodeJS.ProcessEnv;
}): Promise<ChildResult> {
	return collectChild(
		spawn(input.command, [...input.args], {
			cwd: input.cwd,
			env: input.env ?? process.env,
			stdio: ["ignore", "pipe", "pipe"],
		}),
	);
}
