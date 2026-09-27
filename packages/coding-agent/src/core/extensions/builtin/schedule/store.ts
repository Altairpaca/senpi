/**
 * File-per-job store for durable scheduled prompts.
 *
 * Layout under `<agentDir>/schedule/` (the directory a file sits in IS its state):
 *
 *     pending/<id>.json               the job, waiting for its next due time
 *     firing/<id>@<n>~<owner>.json    occurrence <n> claimed by runner <owner> (`<pid>-<processStartMs>`)
 *     failed/<id>@<n>.json            occurrence <n> whose delivery failed or whose runner died mid-delivery
 *     cancelled/<id>                  tombstone: the job was cancelled; nothing may re-arm or deliver it
 *     runners/<pid>.json              lease + heartbeat of each live `senpi schedule run --watch`
 *
 * Every write is atomic (0600 temp file + rename, directories 0700). A runner claims an occurrence
 * by renaming `pending/<id>.json` to its occurrence record: rename is atomic on one filesystem, so
 * among racing runners exactly one wins and the others see ENOENT. A recurring job is re-armed in
 * `pending/` right after the claim, BEFORE delivery, so a runner crash can lose at most the one
 * in-flight occurrence, never the schedule. Cancellation writes the tombstone first and every
 * claim and re-arm re-checks it afterwards, so a cancelled job can never come back.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	InvalidScheduledJobError,
	MAX_JOB_FILE_BYTES,
	parseScheduledJob,
	SCHEDULED_JOB_VERSION,
	type ScheduledJob,
} from "./types.ts";

export type ScheduledJobState = "pending" | "firing" | "failed";

const STATE_DIRS: readonly ScheduledJobState[] = ["pending", "firing", "failed"];
const JOB_ID = /^sch_[a-z0-9]{12}$/;
/** `<id>`, `<id>@<n>` or `<id>@<n>~<pid>-<processStartMs>`, then `.json`. */
const RECORD_FILE = /^(sch_[a-z0-9]{12})(?:@(\d+)(?:~(\d+)-(\d+))?)?\.json$/;
const TOMBSTONE_RETENTION_MS = 24 * 60 * 60 * 1000;

export function scheduleDir(agentDir: string): string {
	return join(agentDir, "schedule");
}

export function isScheduledJobId(id: string): boolean {
	return JOB_ID.test(id);
}

function isFileSystemError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

async function ensureDir(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
}

/** Atomic replace: a hidden 0600 temp file next to the target, then rename over it. */
async function writeAtomic(filePath: string, contents: string): Promise<void> {
	await ensureDir(dirname(filePath));
	const tempPath = join(dirname(filePath), `.schedule-${randomUUID()}.tmp`);
	try {
		await writeFile(tempPath, contents, { encoding: "utf8", mode: 0o600 });
		await rename(tempPath, filePath);
	} catch (error) {
		await rm(tempPath, { force: true });
		throw error;
	}
}

function serialize(job: ScheduledJob): string {
	return `${JSON.stringify(job, null, 2)}\n`;
}

/** Identity of the runner process that owns an occurrence record. */
export interface RunnerIdentity {
	readonly pid: number;
	readonly processStartedAtMs: number;
}

export interface JobRecord {
	readonly state: ScheduledJobState;
	readonly job: ScheduledJob;
	/** Store-relative path, e.g. `firing/sch_x@2~123-456.json`. */
	readonly file: string;
	/** Occurrence number for `firing` and `failed` records. */
	readonly occurrence?: number;
	/** Claiming runner of a `firing` record. */
	readonly owner?: RunnerIdentity;
}

export interface InvalidJobFile {
	readonly state: ScheduledJobState;
	readonly file: string;
	readonly error: string;
}

export interface JobListing {
	readonly jobs: readonly JobRecord[];
	readonly invalid: readonly InvalidJobFile[];
}

async function readJobFile(path: string, expectedId: string): Promise<ScheduledJob> {
	const info = await stat(path);
	if (info.size > MAX_JOB_FILE_BYTES) {
		throw new InvalidScheduledJobError(`scheduled job file exceeds ${MAX_JOB_FILE_BYTES} bytes`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (isFileSystemError(error, "ENOENT")) throw error;
		throw new InvalidScheduledJobError("scheduled job file is not valid JSON");
	}
	const job = parseScheduledJob(parsed);
	if (job.id !== expectedId) throw new InvalidScheduledJobError(`scheduled job id ${job.id} does not match its file`);
	return job;
}

/** Every record in every state, sorted by due time. Unreadable files are reported, never dropped. */
export async function listScheduledJobs(dir: string): Promise<JobListing> {
	const jobs: JobRecord[] = [];
	const invalid: InvalidJobFile[] = [];
	for (const state of STATE_DIRS) {
		let names: string[];
		try {
			names = await readdir(join(dir, state));
		} catch (error) {
			if (isFileSystemError(error, "ENOENT")) continue;
			throw error;
		}
		for (const name of names.sort()) {
			const match = RECORD_FILE.exec(name);
			if (match === null) continue;
			const [, id, occurrence, pid, startedAt] = match;
			const file = join(state, name);
			const shapeOk =
				state === "pending"
					? occurrence === undefined
					: state === "firing"
						? pid !== undefined
						: occurrence !== undefined && pid === undefined;
			if (!shapeOk || id === undefined) {
				invalid.push({ state, file, error: `unexpected record name for ${state}/` });
				continue;
			}
			try {
				const job = await readJobFile(join(dir, file), id);
				jobs.push({
					state,
					job,
					file,
					...(occurrence === undefined ? {} : { occurrence: Number(occurrence) }),
					...(pid === undefined || startedAt === undefined
						? {}
						: { owner: { pid: Number(pid), processStartedAtMs: Number(startedAt) } }),
				});
			} catch (error) {
				// A record claimed, settled or cancelled between readdir and read is simply gone.
				if (isFileSystemError(error, "ENOENT")) continue;
				invalid.push({ state, file, error: error instanceof Error ? error.message : String(error) });
			}
		}
	}
	jobs.sort((a, b) => a.job.dueAt - b.job.dueAt);
	return { jobs, invalid };
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
	const job = parseScheduledJob({
		version: SCHEDULED_JOB_VERSION,
		id: `sch_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
		...input,
		createdAt: now,
		fireCount: 0,
		lastFiredAt: null,
	});
	await writeAtomic(join(dir, "pending", `${job.id}.json`), serialize(job));
	return job;
}

function tombstonePath(dir: string, id: string): string {
	return join(dir, "cancelled", id);
}

export async function isCancelled(dir: string, id: string): Promise<boolean> {
	try {
		await stat(tombstonePath(dir, id));
		return true;
	} catch (error) {
		if (isFileSystemError(error, "ENOENT")) return false;
		throw error;
	}
}

export interface CancelResult {
	readonly job: ScheduledJob;
	/** True when an occurrence was already being delivered; that one delivery may still complete. */
	readonly inFlight: boolean;
	/** Failed occurrence records removed with the job. */
	readonly removedFailed: number;
}

/**
 * Cancels a job for good: writes its tombstone, then removes its pending job and failed records.
 * With `sessionId`, only that session's job may be cancelled. Returns undefined when no such job
 * exists (or it belongs to another session). An occurrence already being delivered cannot be
 * recalled; `inFlight` says so, and nothing after it will re-arm or deliver the job.
 */
export async function cancelScheduledJob(
	dir: string,
	id: string,
	options: { readonly sessionId?: string } = {},
): Promise<CancelResult | undefined> {
	if (!isScheduledJobId(id)) return undefined;
	const records = (await listScheduledJobs(dir)).jobs.filter((record) => record.job.id === id);
	const representative = records.find((record) => record.state === "pending") ?? records[0];
	if (representative === undefined) return undefined;
	if (options.sessionId !== undefined && representative.job.sessionId !== options.sessionId) return undefined;
	await writeAtomic(tombstonePath(dir, id), `${new Date().toISOString()}\n`);
	await rm(join(dir, "pending", `${id}.json`), { force: true });
	const failed = records.filter((record) => record.state === "failed");
	for (const record of failed) await rm(join(dir, record.file), { force: true });
	return {
		job: representative.job,
		inFlight: records.some((record) => record.state === "firing"),
		removedFailed: failed.length,
	};
}

export function occurrenceFile(id: string, occurrence: number, owner: RunnerIdentity): string {
	return join("firing", `${id}@${occurrence}~${owner.pid}-${owner.processStartedAtMs}.json`);
}

/**
 * Claims occurrence `job.fireCount + 1` of a pending job for `owner` by an atomic rename.
 * Returns the store-relative occurrence record, or undefined when another runner claimed it first,
 * the job was cancelled, or the pending file changed since `job` was read.
 */
export async function claimOccurrence(
	dir: string,
	job: ScheduledJob,
	owner: RunnerIdentity,
): Promise<string | undefined> {
	const record = occurrenceFile(job.id, job.fireCount + 1, owner);
	await ensureDir(join(dir, "firing"));
	try {
		await rename(join(dir, "pending", `${job.id}.json`), join(dir, record));
	} catch (error) {
		if (isFileSystemError(error, "ENOENT")) return undefined;
		throw error;
	}
	// The rename took whatever was pending; make sure it is the occurrence we meant to claim.
	const claimed = await readJobFile(join(dir, record), job.id).catch(() => undefined);
	if (claimed === undefined || claimed.fireCount !== job.fireCount || (await isCancelled(dir, job.id))) {
		if (claimed !== undefined && claimed.fireCount !== job.fireCount && !(await isCancelled(dir, job.id))) {
			await rename(join(dir, record), join(dir, "pending", `${job.id}.json`)).catch(() => undefined);
		} else {
			await rm(join(dir, record), { force: true });
		}
		return undefined;
	}
	return record;
}

/**
 * Re-arms a recurring job in `pending/` before its claimed occurrence is delivered. The tombstone
 * is re-checked after the write, so a cancel racing this re-arm always wins.
 */
export async function rearmRecurringJob(dir: string, next: ScheduledJob): Promise<void> {
	if (await isCancelled(dir, next.id)) return;
	const path = join(dir, "pending", `${next.id}.json`);
	await writeAtomic(path, serialize(next));
	if (await isCancelled(dir, next.id)) await rm(path, { force: true });
}

/** Ends a claimed occurrence: removed on delivery, kept in `failed/` with the error otherwise. */
export async function settleOccurrence(
	dir: string,
	record: string,
	job: ScheduledJob,
	occurrence: number,
	outcome: { readonly ok: true } | { readonly ok: false; readonly error: string },
): Promise<void> {
	if (!outcome.ok) {
		await writeAtomic(
			join(dir, "failed", `${job.id}@${occurrence}.json`),
			serialize({ ...job, lastError: outcome.error }),
		);
	}
	await rm(join(dir, record), { force: true });
}

/** Removes tombstones older than a day whose job left no pending or firing record behind. */
export async function pruneTombstones(dir: string, listing: JobListing, now: number): Promise<void> {
	let names: string[];
	try {
		names = await readdir(join(dir, "cancelled"));
	} catch (error) {
		if (isFileSystemError(error, "ENOENT")) return;
		throw error;
	}
	const live = new Set(listing.jobs.filter((record) => record.state !== "failed").map((record) => record.job.id));
	for (const id of names) {
		if (!isScheduledJobId(id) || live.has(id)) continue;
		const info = await stat(tombstonePath(dir, id)).catch(() => undefined);
		if (info !== undefined && now - info.mtimeMs > TOMBSTONE_RETENTION_MS)
			await rm(tombstonePath(dir, id), { force: true });
	}
}

export function runnersDir(dir: string): string {
	return join(dir, "runners");
}
