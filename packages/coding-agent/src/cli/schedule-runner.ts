/**
 * Fires due scheduled prompts for `senpi schedule run`. The clock, the delivery, and the "is the
 * session busy" probe are injected, so every rule here is testable without real waiting or processes.
 *
 * One pass: recover occurrences whose runner died mid-delivery (they move to `failed/`, never
 * re-delivered: at-most-once), then claim and deliver due jobs - concurrently across sessions up to
 * `concurrency`, strictly one at a time within a session.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isOwnerAmong, type LiveRunner, liveRunners } from "../core/extensions/builtin/schedule/runner-lease.ts";
import {
	claimOccurrence,
	type InvalidJobFile,
	isCancelled,
	type JobRecord,
	listScheduledJobs,
	pruneTombstones,
	type RunnerIdentity,
	rearmRecurringJob,
	settleOccurrence,
} from "../core/extensions/builtin/schedule/store.ts";
import {
	formatScheduledMessage,
	nextRecurringDueAt,
	type ScheduledJob,
} from "../core/extensions/builtin/schedule/types.ts";
import { liveSessionHolders } from "../core/session-holders.ts";

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
/** Returns a reason to leave a due job pending for now (for example: its session is open elsewhere). */
export type DeferProbe = (job: ScheduledJob) => Promise<string | undefined>;

export type RunnerEvent =
	| {
			readonly event: "fired";
			readonly id: string;
			readonly sessionId: string;
			readonly occurrence: number;
			readonly outcome: "delivered" | "failed";
			readonly error?: string;
			readonly firedAt: number;
			readonly dueAt: number;
			readonly nextDueAt?: number;
	  }
	| { readonly event: "deferred"; readonly id: string; readonly sessionId: string; readonly reason: string }
	| {
			readonly event: "abandoned";
			readonly id: string;
			readonly sessionId: string;
			readonly occurrence: number;
			readonly error: string;
	  }
	| ({ readonly event: "invalid" } & InvalidJobFile);

export interface RunDueResult {
	readonly events: readonly RunnerEvent[];
	/** Earliest due time among jobs still pending after this pass. */
	readonly nextDueAt: number | undefined;
}

export const ABANDONED_OCCURRENCE_ERROR =
	"the runner exited while delivering this occurrence; outcome unknown, not retried";

export interface RunDueOptions {
	readonly dir: string;
	readonly now: () => number;
	readonly deliver: Delivery;
	readonly owner: RunnerIdentity;
	readonly concurrency?: number;
	readonly shouldDefer?: DeferProbe;
	/** Live runners, for recovering occurrences of dead ones; defaults to reading the leases. */
	readonly runners?: () => Promise<readonly LiveRunner[]>;
}

async function recoverAbandoned(options: RunDueOptions, records: readonly JobRecord[]): Promise<RunnerEvent[]> {
	const firing = records.filter((record) => record.state === "firing");
	if (firing.length === 0) return [];
	const runners = await (options.runners ?? (() => liveRunners(options.dir)))();
	const events: RunnerEvent[] = [];
	for (const record of firing) {
		if (record.owner === undefined || record.occurrence === undefined) continue;
		const mine =
			record.owner.pid === options.owner.pid && record.owner.processStartedAtMs === options.owner.processStartedAtMs;
		if (mine || isOwnerAmong(record.owner, runners)) continue;
		await settleOccurrence(options.dir, record.file, record.job, record.occurrence, {
			ok: false,
			error: ABANDONED_OCCURRENCE_ERROR,
		});
		events.push({
			event: "abandoned",
			id: record.job.id,
			sessionId: record.job.sessionId,
			occurrence: record.occurrence,
			error: ABANDONED_OCCURRENCE_ERROR,
		});
	}
	return events;
}

async function fireOne(options: RunDueOptions, job: ScheduledJob): Promise<RunnerEvent | undefined> {
	const deferReason = await options.shouldDefer?.(job);
	if (deferReason !== undefined)
		return { event: "deferred", id: job.id, sessionId: job.sessionId, reason: deferReason };
	const record = await claimOccurrence(options.dir, job, options.owner);
	if (record === undefined) return undefined;
	const occurrence = job.fireCount + 1;
	const firedAt = options.now();
	let nextDueAt: number | undefined;
	if (job.everyMs !== null) {
		nextDueAt = nextRecurringDueAt(job.dueAt, job.everyMs, firedAt);
		// Re-arm BEFORE delivering: a crash from here on loses at most this one occurrence.
		await rearmRecurringJob(options.dir, { ...job, fireCount: occurrence, lastFiredAt: firedAt, dueAt: nextDueAt });
	}
	let result: DeliveryResult;
	try {
		result = await options.deliver({
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
			fireCount: occurrence,
		});
	} catch (error) {
		result = { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	await settleOccurrence(
		options.dir,
		record,
		{ ...job, fireCount: occurrence, lastFiredAt: firedAt },
		occurrence,
		result,
	);
	return {
		event: "fired",
		id: job.id,
		sessionId: job.sessionId,
		occurrence,
		outcome: result.ok ? "delivered" : "failed",
		...(result.ok ? {} : { error: result.error }),
		firedAt,
		dueAt: job.dueAt,
		...(nextDueAt === undefined || (await isCancelled(options.dir, job.id)) ? {} : { nextDueAt }),
	};
}

export async function runDueJobs(options: RunDueOptions): Promise<RunDueResult> {
	const listing = await listScheduledJobs(options.dir);
	const events: RunnerEvent[] = listing.invalid.map((invalid) => ({ event: "invalid", ...invalid }));
	events.push(...(await recoverAbandoned(options, listing.jobs)));
	await pruneTombstones(options.dir, listing, options.now());

	let nextDueAt: number | undefined;
	const noteNext = (dueAt: number) => {
		nextDueAt = nextDueAt === undefined ? dueAt : Math.min(nextDueAt, dueAt);
	};
	const bySession = new Map<string, ScheduledJob[]>();
	for (const { state, job } of listing.jobs) {
		if (state !== "pending") continue;
		if (job.dueAt > options.now()) {
			noteNext(job.dueAt);
			continue;
		}
		if (await isCancelled(options.dir, job.id)) continue;
		const queue = bySession.get(job.sessionId) ?? [];
		queue.push(job);
		bySession.set(job.sessionId, queue);
	}

	const queues = [...bySession.values()];
	const workers = Math.max(1, Math.min(options.concurrency ?? 4, queues.length));
	let next = 0;
	await Promise.all(
		Array.from({ length: workers }, async () => {
			while (next < queues.length) {
				const queue = queues[next++] ?? [];
				for (const job of queue) {
					const event = await fireOne(options, job);
					if (event === undefined) continue;
					events.push(event);
					if (event.event === "fired" && event.nextDueAt !== undefined) noteNext(event.nextDueAt);
					if (event.event === "deferred") {
						noteNext(job.dueAt);
						break; // keep this session's later jobs behind the deferred one
					}
				}
			}
		}),
	);
	return { events, nextDueAt };
}

/** Default-delivery guard: do not start a second writer on a session another process has open. */
export async function deferWhileSessionOpen(job: ScheduledJob): Promise<string | undefined> {
	if (job.sessionFile === null || !existsSync(job.sessionFile)) return undefined;
	const holders = await liveSessionHolders(job.sessionFile, job.sessionId);
	if (holders.length === 0) return undefined;
	return `session is open in pid ${holders.map((holder) => holder.pid).join(", ")}; waiting until it closes`;
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

/**
 * `--exec <command>`: a shell command receives the event as JSON on stdin. It inherits the runner's
 * environment (the operator chose both the command and the environment the runner starts with).
 */
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
		if (event.sessionFile !== null && !existsSync(event.sessionFile)) {
			return { ok: false, error: `session file no longer exists: ${event.sessionFile}` };
		}
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
