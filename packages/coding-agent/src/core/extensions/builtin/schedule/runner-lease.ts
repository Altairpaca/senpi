/**
 * Runner leases: every `senpi schedule run` process publishes `runners/<pid>.json` in the terminal
 * lease format (pid + boot instant + process start instant) plus a heartbeat `beatAt`. The identity
 * lets a reused pid be told apart from the runner that wrote the lease; the heartbeat, refreshed on a
 * timer even while a delivery is running, tells the tool whether a runner will actually fire jobs.
 */

import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
	breakStaleLock,
	publishReplace,
	readLeaseText,
	reclaimLockState,
	unlinkIfPresent,
} from "../terminal/lease-file.ts";
import { ownProcessStartedAtMs, processBootAtMs, sameProcessStart } from "../terminal/process-identity.ts";
import { type RunnerIdentity, runnersDir } from "./store.ts";

/** A lease whose heartbeat is older than this does not count as an available runner. */
export const RUNNER_HEARTBEAT_STALE_MS = 120_000;
/** How often a runner refreshes its heartbeat. */
export const RUNNER_HEARTBEAT_INTERVAL_MS = 30_000;

export function ownRunnerIdentity(): RunnerIdentity {
	return { pid: process.pid, processStartedAtMs: ownProcessStartedAtMs() };
}

function leasePath(dir: string, pid: number): string {
	return join(runnersDir(dir), `${pid}.json`);
}

export async function writeRunnerLease(
	dir: string,
	lease: { readonly startedAt: number; readonly watch: boolean; readonly exec: string | null },
	now: number,
): Promise<void> {
	await mkdir(runnersDir(dir), { recursive: true, mode: 0o700 });
	const identity = ownRunnerIdentity();
	await publishReplace(
		leasePath(dir, identity.pid),
		JSON.stringify({ ...identity, bootAtMs: processBootAtMs(), beatAt: now, ...lease }),
	);
}

export async function removeRunnerLease(dir: string): Promise<void> {
	await unlinkIfPresent(leasePath(dir, process.pid));
}

export interface LiveRunner {
	readonly pid: number;
	readonly processStartedAtMs: number;
	readonly beatAt: number;
	readonly watch: boolean;
	readonly exec: string | null;
}

function parseLease(raw: string): Omit<LiveRunner, "pid" | "processStartedAtMs"> | undefined {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const beatAt = "beatAt" in parsed ? parsed.beatAt : undefined;
		if (typeof beatAt !== "number") return undefined;
		const watch = "watch" in parsed && parsed.watch === true;
		const exec = "exec" in parsed && typeof parsed.exec === "string" ? parsed.exec : null;
		return { beatAt, watch, exec };
	} catch {
		return undefined;
	}
}

/** Runners whose process is alive (same identity); dead or reused-pid leases are removed. */
export async function liveRunners(dir: string): Promise<LiveRunner[]> {
	let names: string[];
	try {
		names = await readdir(runnersDir(dir));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
	const runners: LiveRunner[] = [];
	for (const name of names) {
		if (!/^\d+\.json$/.test(name)) continue;
		const path = join(runnersDir(dir), name);
		const state = await reclaimLockState(path);
		if (state.state === "stale") await breakStaleLock(path, state.raw);
		if (state.state !== "held" || state.holder === undefined) continue;
		const raw = await readLeaseText(path);
		const lease = raw === undefined ? undefined : parseLease(raw);
		if (lease === undefined) continue;
		runners.push({ pid: state.holder.pid, processStartedAtMs: state.holder.processStartedAtMs, ...lease });
	}
	return runners;
}

/** True when a live `--watch` runner has refreshed its heartbeat recently. */
export async function isWatchRunnerAvailable(dir: string, now: number): Promise<boolean> {
	return (await liveRunners(dir)).some((runner) => runner.watch && now - runner.beatAt <= RUNNER_HEARTBEAT_STALE_MS);
}

/** True when the runner that claimed an occurrence is still the same live process. */
export function isOwnerAmong(owner: RunnerIdentity, runners: readonly LiveRunner[]): boolean {
	return runners.some(
		(runner) => runner.pid === owner.pid && sameProcessStart(runner.processStartedAtMs, owner.processStartedAtMs),
	);
}
