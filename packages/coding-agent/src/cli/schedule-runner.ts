/**
 * Fires due scheduled prompts for `senpi schedule run`. The clock, the delivery, and the "is the
 * session busy" probe are injected, so every rule here is testable without real waiting or processes.
 *
 * One pass: recover occurrences whose runner died mid-delivery (they move to `failed/`, never
 * re-delivered: at-most-once), then claim and deliver due jobs - concurrently across sessions up to
 * `concurrency`, strictly one at a time within a session.
 */

import { join } from "node:path";
import {
	claimOccurrence,
	pruneTombstones,
	rearmRecurringJob,
	settleOccurrence,
} from "../core/extensions/builtin/schedule/occurrences.ts";
import {
	acquireSessionDeliveryLock,
	isOwnerAmong,
	type LiveRunner,
	liveRunners,
} from "../core/extensions/builtin/schedule/runner-lease.ts";
import {
	type InvalidJobFile,
	isCancelled,
	type JobRecord,
	listScheduledJobs,
	type RunnerIdentity,
	readJobFile,
} from "../core/extensions/builtin/schedule/store.ts";
import {
	formatScheduledMessage,
	nextRecurringDueAt,
	type ScheduledJob,
} from "../core/extensions/builtin/schedule/types.ts";
import type { DeferProbe, Delivery, DeliveryResult } from "./schedule-delivery.ts";

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

/** Re-reads a pending job under the session lock; undefined when it is gone, cancelled, or not due. */
async function freshPendingJob(options: RunDueOptions, id: string): Promise<ScheduledJob | undefined> {
	const job = await readJobFile(join(options.dir, "pending", `${id}.json`), id).catch((error: unknown) => {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	});
	if (job === undefined || job.dueAt > options.now() || (await isCancelled(options.dir, id))) return undefined;
	return job;
}

async function fireOne(options: RunDueOptions, listed: ScheduledJob): Promise<RunnerEvent | undefined> {
	const lock = await acquireSessionDeliveryLock(options.dir, listed.sessionId);
	if (!lock.acquired) {
		const holder = lock.heldByPid === undefined ? "another runner" : `runner pid ${lock.heldByPid}`;
		return {
			event: "deferred",
			id: listed.id,
			sessionId: listed.sessionId,
			reason: `${holder} is delivering to this session`,
		};
	}
	try {
		const job = await freshPendingJob(options, listed.id);
		if (job === undefined) return undefined;
		const deferReason = await options.shouldDefer?.(job);
		if (deferReason !== undefined)
			return { event: "deferred", id: job.id, sessionId: job.sessionId, reason: deferReason };
		return await deliverClaimed(options, job);
	} finally {
		await lock.release();
	}
}

async function deliverClaimed(options: RunDueOptions, job: ScheduledJob): Promise<RunnerEvent | undefined> {
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
