/**
 * Fires due scheduled prompts. Used by `senpi schedule run`; the clock and the delivery are
 * injected so every rule here is testable without real waiting or real processes.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { claimScheduledJob, type InvalidJobFile, listScheduledJobs, settleScheduledJob } from "./store.ts";
import { formatScheduledMessage, nextRecurringDueAt, type ScheduledJob } from "./types.ts";

/** What a delivery hook receives on stdin, one JSON object. */
export interface ScheduledPromptEvent {
	readonly type: "scheduled_prompt";
	readonly id: string;
	readonly sessionId: string;
	readonly sessionFile: string | null;
	readonly cwd: string;
	/** The prompt exactly as scheduled. */
	readonly prompt: string;
	/** The prompt with a one-line provenance header; what the default delivery sends. */
	readonly message: string;
	readonly dueAt: number;
	readonly firedAt: number;
	readonly everyMs: number | null;
	/** Occurrence number, starting at 1. */
	readonly fireCount: number;
}

export type DeliveryResult = { readonly ok: true } | { readonly ok: false; readonly error: string };
export type Delivery = (event: ScheduledPromptEvent) => Promise<DeliveryResult>;

export interface FiredJob {
	readonly id: string;
	readonly sessionId: string;
	readonly outcome: "delivered" | "failed";
	readonly error?: string;
	readonly firedAt: number;
	readonly dueAt: number;
	/** Next due time for a recurring job. */
	readonly nextDueAt?: number;
}

export interface RunDueResult {
	readonly fired: readonly FiredJob[];
	readonly invalid: readonly InvalidJobFile[];
	/** Earliest due time among jobs still pending after this pass. */
	readonly nextDueAt: number | undefined;
}

export async function runDueJobs(options: {
	readonly dir: string;
	readonly now: () => number;
	readonly deliver: Delivery;
}): Promise<RunDueResult> {
	const { jobs, invalid } = await listScheduledJobs(options.dir);
	const fired: FiredJob[] = [];
	let nextDueAt: number | undefined;
	const noteNext = (dueAt: number) => {
		nextDueAt = nextDueAt === undefined ? dueAt : Math.min(nextDueAt, dueAt);
	};
	for (const { state, job } of jobs) {
		if (state !== "pending") continue;
		if (job.dueAt > options.now()) {
			noteNext(job.dueAt);
			continue;
		}
		if (!(await claimScheduledJob(options.dir, job.id))) continue;
		const firedAt = options.now();
		const event: ScheduledPromptEvent = {
			type: "scheduled_prompt",
			id: job.id,
			sessionId: job.sessionId,
			sessionFile: job.sessionFile,
			cwd: job.cwd,
			prompt: job.prompt,
			message: formatScheduledMessage(job, firedAt),
			dueAt: job.dueAt,
			firedAt,
			everyMs: job.everyMs,
			fireCount: job.fireCount + 1,
		};
		let result: DeliveryResult;
		try {
			result = await options.deliver(event);
		} catch (error) {
			result = { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		const next: ScheduledJob = {
			...job,
			fireCount: job.fireCount + 1,
			lastFiredAt: firedAt,
			lastError: result.ok ? null : result.error,
			dueAt: job.everyMs === null ? job.dueAt : nextRecurringDueAt(job.dueAt, job.everyMs, firedAt),
		};
		await settleScheduledJob(options.dir, next, result.ok ? "delivered" : "failed");
		if (next.everyMs !== null) noteNext(next.dueAt);
		fired.push({
			id: job.id,
			sessionId: job.sessionId,
			outcome: result.ok ? "delivered" : "failed",
			...(result.ok ? {} : { error: result.error }),
			firedAt,
			dueAt: job.dueAt,
			...(next.everyMs === null ? {} : { nextDueAt: next.dueAt }),
		});
	}
	return { fired, invalid, nextDueAt };
}

export interface ProcessLaunch {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly stdin?: string;
}

const STDERR_TAIL_CHARS = 2000;

/** Runs one delivery process to completion; exit 0 means delivered. */
export function runDeliveryProcess(launch: ProcessLaunch, timeoutMs: number): Promise<DeliveryResult> {
	return new Promise((resolve) => {
		const child = spawn(launch.command, [...launch.args], {
			cwd: launch.cwd,
			env: launch.env,
			stdio: ["pipe", "ignore", "pipe"],
		});
		let stderr = "";
		let settled = false;
		const finish = (result: DeliveryResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish({ ok: false, error: `delivery timed out after ${Math.round(timeoutMs / 1000)}s` });
		}, timeoutMs);
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
		});
		child.on("error", (error) => finish({ ok: false, error: error.message }));
		child.on("close", (code, signal) => {
			if (code === 0) finish({ ok: true });
			else {
				const status = code === null ? `signal ${signal}` : `exit code ${code}`;
				finish({ ok: false, error: stderr.trim() ? `${status}: ${stderr.trim()}` : status });
			}
		});
		child.stdin?.on("error", () => {});
		child.stdin?.end(launch.stdin ?? "");
	});
}

function eventEnv(event: ScheduledPromptEvent): NodeJS.ProcessEnv {
	return {
		...process.env,
		SENPI_SCHEDULE_ID: event.id,
		SENPI_SCHEDULE_SESSION_ID: event.sessionId,
		SENPI_SCHEDULE_SESSION_FILE: event.sessionFile ?? "",
		SENPI_SCHEDULE_CWD: event.cwd,
	};
}

/** `--exec <command>`: a shell command receives the event as JSON on stdin. */
export function execHookDelivery(command: string, timeoutMs: number): Delivery {
	const shell =
		process.platform === "win32"
			? { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", command] }
			: { command: "/bin/sh", args: ["-c", command] };
	return (event) =>
		runDeliveryProcess(
			{ ...shell, env: eventEnv(event), stdin: `${JSON.stringify(event)}\n`, cwd: process.cwd() },
			timeoutMs,
		);
}

/**
 * Default delivery: resume the scheduling session headlessly (`senpi -p --session <file|id>`) in
 * its working directory, so the fired prompt runs as a new turn of that session.
 */
export function sessionResumeDelivery(
	senpi: { command: string; args: readonly string[] },
	timeoutMs: number,
): Delivery {
	return async (event) => {
		if (!existsSync(event.cwd)) return { ok: false, error: `working directory no longer exists: ${event.cwd}` };
		return runDeliveryProcess(
			{
				command: senpi.command,
				args: [...senpi.args, "-p", "--session", event.sessionFile ?? event.sessionId, event.message],
				cwd: event.cwd,
				env: eventEnv(event),
			},
			timeoutMs,
		);
	};
}
