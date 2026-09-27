/**
 * File-per-job store for durable scheduled prompts.
 *
 * Layout under `<agentDir>/schedule/`:
 *
 *     pending/<id>.json   waiting for its due time
 *     firing/<id>.json    claimed by a runner that is delivering it right now
 *     failed/<id>.json    a one-shot job whose delivery failed (kept for inspection)
 *     runner.json         heartbeat of the live `senpi schedule run --watch` process
 *
 * The directory a job file sits in IS its state. Every write is atomic (temp file + rename), and
 * a runner claims a job by renaming it from `pending/` into `firing/`: rename is atomic on one
 * filesystem, so when several runners race for the same job exactly one wins and the others see
 * ENOENT. Delivery is therefore at-most-once per occurrence.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "../../../session-sidecar-store.ts";
import {
	InvalidScheduledJobError,
	parseScheduledJob,
	SCHEDULED_JOB_STATES,
	SCHEDULED_JOB_VERSION,
	type ScheduledJob,
	type ScheduledJobState,
} from "./types.ts";

const TEMP_PREFIX = "schedule";
const JOB_FILE = /^(sch_[a-z0-9]+)\.json$/;

export function scheduleDir(agentDir: string): string {
	return join(agentDir, "schedule");
}

function jobPath(dir: string, state: ScheduledJobState, id: string): string {
	return join(dir, state, `${id}.json`);
}

function isFileSystemError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

async function writeJob(dir: string, state: ScheduledJobState, job: ScheduledJob): Promise<void> {
	await mkdir(join(dir, state), { recursive: true, mode: 0o700 });
	await writeAtomic(jobPath(dir, state, job.id), `${JSON.stringify(job, null, 2)}\n`, TEMP_PREFIX);
}

export interface NewScheduledJob {
	readonly sessionId: string;
	readonly sessionFile: string | null;
	readonly cwd: string;
	readonly prompt: string;
	readonly dueAt: number;
	readonly everyMs: number | null;
}

export async function createScheduledJob(dir: string, input: NewScheduledJob, now: number): Promise<ScheduledJob> {
	const job: ScheduledJob = {
		version: SCHEDULED_JOB_VERSION,
		id: `sch_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
		sessionId: input.sessionId,
		sessionFile: input.sessionFile,
		cwd: input.cwd,
		prompt: input.prompt,
		createdAt: now,
		dueAt: input.dueAt,
		everyMs: input.everyMs,
		fireCount: 0,
		lastFiredAt: null,
		lastError: null,
	};
	await writeJob(dir, "pending", job);
	return job;
}

export interface ListedJob {
	readonly state: ScheduledJobState;
	readonly job: ScheduledJob;
}

export interface InvalidJobFile {
	readonly state: ScheduledJobState;
	readonly file: string;
	readonly error: string;
}

export interface JobListing {
	readonly jobs: readonly ListedJob[];
	readonly invalid: readonly InvalidJobFile[];
}

async function readJobFile(path: string): Promise<ScheduledJob> {
	const raw = await readFile(path, "utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new InvalidScheduledJobError("scheduled job file is not valid JSON");
	}
	return parseScheduledJob(parsed);
}

/** Every job in every state, sorted by due time. Unreadable files are reported, never dropped. */
export async function listScheduledJobs(dir: string): Promise<JobListing> {
	const jobs: ListedJob[] = [];
	const invalid: InvalidJobFile[] = [];
	for (const state of SCHEDULED_JOB_STATES) {
		let names: string[];
		try {
			names = await readdir(join(dir, state));
		} catch (error) {
			if (isFileSystemError(error, "ENOENT")) continue;
			throw error;
		}
		for (const name of names.sort()) {
			if (!JOB_FILE.test(name)) continue;
			try {
				jobs.push({ state, job: await readJobFile(join(dir, state, name)) });
			} catch (error) {
				// A job claimed or cancelled between readdir and read is simply gone, not invalid.
				if (isFileSystemError(error, "ENOENT")) continue;
				invalid.push({
					state,
					file: join(state, name),
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}
	jobs.sort((a, b) => a.job.dueAt - b.job.dueAt);
	return { jobs, invalid };
}

/**
 * Removes a job in any state. With `sessionId`, only that session's job may be removed.
 * Returns the removed job, or undefined when no such job exists (or it belongs to another session).
 */
export async function cancelScheduledJob(
	dir: string,
	id: string,
	options: { readonly sessionId?: string } = {},
): Promise<ListedJob | undefined> {
	if (!/^sch_[a-z0-9]+$/.test(id)) return undefined;
	for (const state of SCHEDULED_JOB_STATES) {
		const path = jobPath(dir, state, id);
		let job: ScheduledJob;
		try {
			job = await readJobFile(path);
		} catch (error) {
			// Missing here, or unreadable: `list` reports unreadable files; cancel never guesses an owner.
			if (isFileSystemError(error, "ENOENT") || error instanceof InvalidScheduledJobError) continue;
			throw error;
		}
		if (options.sessionId !== undefined && job.sessionId !== options.sessionId) return undefined;
		await rm(path, { force: true });
		return { state, job };
	}
	return undefined;
}

/**
 * Atomically moves a due job from `pending/` to `firing/`. Returns false when another runner
 * claimed (or someone cancelled) it first.
 */
export async function claimScheduledJob(dir: string, id: string): Promise<boolean> {
	await mkdir(join(dir, "firing"), { recursive: true, mode: 0o700 });
	try {
		await rename(jobPath(dir, "pending", id), jobPath(dir, "firing", id));
		return true;
	} catch (error) {
		if (isFileSystemError(error, "ENOENT")) return false;
		throw error;
	}
}

/**
 * Settles a claimed job. A one-shot success is deleted; a one-shot failure moves to `failed/`;
 * a recurring job is always re-armed in `pending/` (a failed delivery is recorded, not terminal).
 */
export async function settleScheduledJob(
	dir: string,
	next: ScheduledJob,
	outcome: "delivered" | "failed",
): Promise<void> {
	if (next.everyMs !== null) {
		await writeJob(dir, "pending", next);
	} else if (outcome === "failed") {
		await writeJob(dir, "failed", next);
	}
	await rm(jobPath(dir, "firing", next.id), { force: true });
}

export interface RunnerHeartbeat {
	readonly pid: number;
	readonly startedAt: number;
	readonly beatAt: number;
	readonly exec: string | null;
}

export async function writeRunnerHeartbeat(dir: string, heartbeat: RunnerHeartbeat): Promise<void> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await writeAtomic(join(dir, "runner.json"), `${JSON.stringify(heartbeat)}\n`, TEMP_PREFIX);
}

export async function clearRunnerHeartbeat(dir: string, pid: number): Promise<void> {
	const current = await readRunnerHeartbeat(dir);
	if (current?.pid === pid) await rm(join(dir, "runner.json"), { force: true });
}

export async function readRunnerHeartbeat(dir: string): Promise<RunnerHeartbeat | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(join(dir, "runner.json"), "utf8"));
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const record = parsed as Record<string, unknown>;
		if (typeof record.pid !== "number" || typeof record.beatAt !== "number") return undefined;
		return {
			pid: record.pid,
			startedAt: typeof record.startedAt === "number" ? record.startedAt : record.beatAt,
			beatAt: record.beatAt,
			exec: typeof record.exec === "string" ? record.exec : null,
		};
	} catch {
		return undefined;
	}
}

/** True when a watch runner's heartbeat names a live process. */
export async function isRunnerAlive(dir: string): Promise<boolean> {
	const heartbeat = await readRunnerHeartbeat(dir);
	if (heartbeat === undefined) return false;
	try {
		process.kill(heartbeat.pid, 0);
		return true;
	} catch (error) {
		return isFileSystemError(error, "EPERM");
	}
}
