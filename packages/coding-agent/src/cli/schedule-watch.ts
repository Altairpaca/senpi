/**
 * The runner process of `senpi schedule run [--watch]`: its lease and heartbeat, the pass loop
 * (woken by new jobs through a `pending/` watch, by the next due time, or by the poll interval),
 * signal handling, and the JSON event lines it prints.
 */

import { type FSWatcher, mkdirSync, watch } from "node:fs";
import { join } from "node:path";
import { isBunBinary } from "../config.ts";
import {
	ownRunnerIdentity,
	RUNNER_HEARTBEAT_INTERVAL_MS,
	removeRunnerLease,
	writeRunnerLease,
} from "../core/extensions/builtin/schedule/runner-lease.ts";
import { resolveCliMainPath } from "../modes/rpc/host-lifecycle.ts";
import {
	type DeferProbe,
	type Delivery,
	deferWhileSessionOpen,
	execHookDelivery,
	sessionResumeDelivery,
} from "./schedule-delivery.ts";
import { type RunDueResult, runDueJobs } from "./schedule-runner.ts";

export interface RunOptions {
	readonly watch: boolean;
	readonly exec: string | undefined;
	readonly pollSeconds: number;
	readonly timeoutSeconds: number;
	readonly concurrency: number;
}

export function writeLine(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

interface DeliveryPlan {
	readonly deliver: Delivery;
	readonly shouldDefer: DeferProbe | undefined;
}

function resolveDelivery(options: RunOptions): DeliveryPlan {
	const timeoutMs = options.timeoutSeconds * 1000;
	if (options.exec !== undefined)
		return { deliver: execHookDelivery(options.exec, timeoutMs), shouldDefer: undefined };
	return {
		deliver: sessionResumeDelivery(
			{ command: process.execPath, args: isBunBinary ? [] : [...process.execArgv, resolveCliMainPath()] },
			timeoutMs,
		),
		shouldDefer: deferWhileSessionOpen,
	};
}

/** Reports a pass; a job deferred for the same reason is reported once per runner, not every pass. */
function reporter(): (result: RunDueResult) => boolean {
	const deferred = new Map<string, string>();
	return (result) => {
		let ok = true;
		for (const event of result.events) {
			if (event.event === "deferred") {
				if (deferred.get(event.id) === event.reason) continue;
				deferred.set(event.id, event.reason);
			} else if (event.event === "fired") {
				deferred.delete(event.id);
				if (event.outcome === "failed") ok = false;
			}
			writeLine(event);
		}
		return ok;
	};
}

export async function runPasses(dir: string, options: RunOptions): Promise<number> {
	const plan = resolveDelivery(options);
	const owner = ownRunnerIdentity();
	const startedAt = Date.now();
	const lease = () =>
		writeRunnerLease(dir, { startedAt, watch: options.watch, exec: options.exec ?? null }, Date.now());
	const report = reporter();
	const pass = () =>
		runDueJobs({
			dir,
			now: Date.now,
			deliver: plan.deliver,
			owner,
			concurrency: options.concurrency,
			shouldDefer: plan.shouldDefer,
		});

	await lease();
	// The heartbeat keeps beating while a long delivery runs, so this runner never looks dead mid-delivery.
	let leaseFailing = false;
	const heartbeat = setInterval(() => {
		lease().then(
			() => {
				leaseFailing = false;
			},
			(error: unknown) => {
				// Reported once per failure streak: until it recovers, tools see no available runner.
				if (!leaseFailing)
					writeLine({ event: "lease_error", error: error instanceof Error ? error.message : String(error) });
				leaseFailing = true;
			},
		);
	}, RUNNER_HEARTBEAT_INTERVAL_MS);
	let watcher: FSWatcher | undefined;
	let stopping = false;
	let wake: (() => void) | undefined;
	const stop = () => {
		stopping = true;
		wake?.();
	};
	try {
		if (!options.watch) return report(await pass()) ? 0 : 1;

		process.on("SIGTERM", stop);
		process.on("SIGINT", stop);
		// A job created by another process wakes the runner at once instead of at the next poll.
		const pendingDir = join(dir, "pending");
		mkdirSync(pendingDir, { recursive: true, mode: 0o700 });
		watcher = watch(pendingDir, () => wake?.());
		writeLine({ event: "watching", pid: process.pid, dir, pollSeconds: options.pollSeconds });
		while (!stopping) {
			let rescan = false;
			const woken = new Promise<void>((resolve) => {
				wake = () => {
					rescan = true;
					resolve();
				};
			});
			const result = await pass();
			report(result);
			if (stopping) break;
			if (rescan) continue; // something changed during the pass
			const untilDue = result.nextDueAt === undefined ? Number.POSITIVE_INFINITY : result.nextDueAt - Date.now();
			const waitMs = Math.max(0, Math.min(options.pollSeconds * 1000, untilDue));
			let timer: NodeJS.Timeout | undefined;
			await Promise.race([woken, new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))]);
			clearTimeout(timer);
		}
		writeLine({ event: "stopped", pid: process.pid });
		return 0;
	} finally {
		clearInterval(heartbeat);
		watcher?.close();
		process.off("SIGTERM", stop);
		process.off("SIGINT", stop);
		await removeRunnerLease(dir);
	}
}
