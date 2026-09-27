/**
 * Data model for durable scheduled prompts.
 *
 * A scheduled prompt outlives the process that created it: it is one JSON file in the
 * agent directory, written by the `schedule_prompt` tool from ANY run mode (interactive, RPC,
 * `--print`), and fired later by a separate `senpi schedule run` process. Nothing here touches
 * the clock or the filesystem.
 */

export const SCHEDULED_JOB_VERSION = 1;

/** Shortest recurrence accepted; a runner polls, so tighter cadences would only drift. */
export const MIN_EVERY_SECONDS = 60;
/** Farthest a job may be scheduled ahead of its creation. */
export const MAX_SCHEDULE_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;

/** Where a job file currently lives, which IS its state. */
export const SCHEDULED_JOB_STATES = ["pending", "firing", "failed"] as const;
export type ScheduledJobState = (typeof SCHEDULED_JOB_STATES)[number];

export interface ScheduledJob {
	readonly version: typeof SCHEDULED_JOB_VERSION;
	readonly id: string;
	/** Session that scheduled the prompt; a fired prompt belongs to it. */
	readonly sessionId: string;
	/** Session file at creation time, when the session was persisted. */
	readonly sessionFile: string | null;
	/** Working directory of the scheduling session. */
	readonly cwd: string;
	/** Exact text to deliver when the job fires. */
	readonly prompt: string;
	readonly createdAt: number;
	/** Next wall-clock time the job is due, epoch ms. */
	readonly dueAt: number;
	/** Recurrence period in ms, or null for a one-shot job. */
	readonly everyMs: number | null;
	readonly fireCount: number;
	readonly lastFiredAt: number | null;
	/** Last delivery failure of a recurring job, or the reason a one-shot job failed. */
	readonly lastError: string | null;
}

export class InvalidScheduledJobError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidScheduledJobError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(raw: Record<string, unknown>, key: string): string {
	const value = raw[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new InvalidScheduledJobError(`scheduled job field "${key}" must be a non-empty string`);
	}
	return value;
}

function requireFiniteNumber(raw: Record<string, unknown>, key: string): number {
	const value = raw[key];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new InvalidScheduledJobError(`scheduled job field "${key}" must be a finite number`);
	}
	return value;
}

function nullableNumber(raw: Record<string, unknown>, key: string): number | null {
	return raw[key] === null || raw[key] === undefined ? null : requireFiniteNumber(raw, key);
}

function nullableString(raw: Record<string, unknown>, key: string): string | null {
	const value = raw[key];
	if (value === null || value === undefined) return null;
	if (typeof value !== "string") throw new InvalidScheduledJobError(`scheduled job field "${key}" must be a string`);
	return value;
}

/** Validates one parsed job file. Fails closed: a malformed job is reported, never fired. */
export function parseScheduledJob(raw: unknown): ScheduledJob {
	if (!isRecord(raw)) throw new InvalidScheduledJobError("scheduled job must be a JSON object");
	if (raw.version !== SCHEDULED_JOB_VERSION) {
		throw new InvalidScheduledJobError(`unsupported scheduled job version: ${JSON.stringify(raw.version)}`);
	}
	const everyMs = nullableNumber(raw, "everyMs");
	if (everyMs !== null && everyMs < MIN_EVERY_SECONDS * 1000) {
		throw new InvalidScheduledJobError(`scheduled job recurrence must be at least ${MIN_EVERY_SECONDS}s`);
	}
	return {
		version: SCHEDULED_JOB_VERSION,
		id: requireString(raw, "id"),
		sessionId: requireString(raw, "sessionId"),
		sessionFile: nullableString(raw, "sessionFile"),
		cwd: requireString(raw, "cwd"),
		prompt: requireString(raw, "prompt"),
		createdAt: requireFiniteNumber(raw, "createdAt"),
		dueAt: requireFiniteNumber(raw, "dueAt"),
		everyMs,
		fireCount: requireFiniteNumber(raw, "fireCount"),
		lastFiredAt: nullableNumber(raw, "lastFiredAt"),
		lastError: nullableString(raw, "lastError"),
	};
}

/** First occurrence of a recurring job strictly after `now`; missed occurrences collapse into it. */
export function nextRecurringDueAt(dueAt: number, everyMs: number, now: number): number {
	if (dueAt > now) return dueAt;
	const missed = Math.floor((now - dueAt) / everyMs) + 1;
	return dueAt + missed * everyMs;
}

/** Text the fired prompt is delivered as: a one-line provenance header, then the prompt verbatim. */
export function formatScheduledMessage(job: ScheduledJob, firedAt: number): string {
	const recurrence = job.everyMs === null ? "" : `, repeats every ${Math.round(job.everyMs / 1000)}s`;
	return `[Scheduled prompt ${job.id}: created ${new Date(job.createdAt).toISOString()}, due ${new Date(job.dueAt).toISOString()}, fired ${new Date(firedAt).toISOString()}${recurrence}]\n${job.prompt}`;
}
