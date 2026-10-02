import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";

export type ChildResult = {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly pid: number;
};

export async function waitForChildReady(child: ChildProcess): Promise<void> {
	await Promise.race([
		once(child, "message"),
		once(child, "close").then(() => {
			throw new TypeError("Child probe closed before its ready marker");
		}),
	]);
}

/** Close drains both pipes; the watchdog guards a hang, never child startup speed. */
export function collectChild(child: ChildProcess): Promise<ChildResult> {
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
			reject(new TypeError(`Child probe hung without closing\nstdout:\n${stdout}\nstderr:\n${stderr}`));
		}, 240_000);
		child.once("error", (error) => {
			clearTimeout(watchdog);
			reject(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(watchdog);
			const pid = child.pid;
			if (pid === undefined) {
				reject(new TypeError("Child probe closed without spawning"));
				return;
			}
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
