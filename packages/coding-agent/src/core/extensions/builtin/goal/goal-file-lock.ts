import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import {
	FILE_STORAGE_LOCK_OPTIONS,
	FILE_STORAGE_LOCK_RETRY_BUDGET_MS,
	FILE_STORAGE_LOCK_RETRY_MAX_DELAY_MS,
	FILE_STORAGE_LOCK_RETRY_MIN_DELAY_MS,
	isLockError,
} from "../../../lockfile-policy.ts";
import { serializeByKey } from "../../../session-sidecar-store.ts";
import { goalFilePath } from "./persistence.ts";
import type { GoalStoreRef } from "./types.ts";

export class GoalStoreBusyError extends Error {
	readonly path: string;
	readonly waitedMs: number;

	constructor(path: string, waitedMs: number, cause?: unknown) {
		super(
			`Goal store is busy: lock on ${path} was held for ${waitedMs}ms. ` +
				"Another process may be updating the goal; close unused sessions if contention persists.",
			{ cause },
		);
		this.name = "GoalStoreBusyError";
		this.path = path;
		this.waitedMs = waitedMs;
	}
}

export class GoalStoreLockCompromisedError extends Error {
	readonly path: string;

	constructor(path: string, cause?: unknown) {
		super(
			`Goal store lock on ${path} was compromised: another process reclaimed it. ` +
				"The stale write was rejected to preserve the newer goal state.",
			{ cause },
		);
		this.name = "GoalStoreLockCompromisedError";
		this.path = path;
	}
}

/**
 * The lock directory sits beside the goal file under a fixed-length name. proper-lockfile's
 * default `<file>.lock` would overflow NAME_MAX for a goal whose encoded basename is already
 * at the 255-byte component limit, which the store supports.
 */
export function goalLockFilePath(ref: GoalStoreRef): string {
	const filePath = goalFilePath(ref);
	const digest = createHash("sha256").update(basename(filePath)).digest("hex").slice(0, 40);
	return join(dirname(filePath), `.goal-lock-${digest}`);
}

async function acquireGoalLock(
	filePath: string,
	lockfilePath: string,
): Promise<{ release: () => Promise<void>; throwIfCompromised: () => void }> {
	// realpath:false locks `<file>.lock` without the goal file existing; creating a placeholder
	// goal file here would make migrateLegacyGoalFile skip a pending legacy import.
	await mkdir(dirname(filePath), { recursive: true });

	let compromised = false;
	let compromisedError: Error | undefined;

	const startedAt = Date.now();
	let attempt = 0;
	while (true) {
		try {
			const release = await lockfile.lock(filePath, {
				...FILE_STORAGE_LOCK_OPTIONS,
				lockfilePath,
				retries: 0,
				onCompromised: (error: Error) => {
					compromised = true;
					compromisedError = error;
				},
			});
			return {
				release,
				throwIfCompromised: () => {
					if (compromised) throw new GoalStoreLockCompromisedError(filePath, compromisedError);
				},
			};
		} catch (error) {
			if (!isLockError(error)) throw error;
			const waitedMs = Date.now() - startedAt;
			if (waitedMs >= FILE_STORAGE_LOCK_RETRY_BUDGET_MS) {
				throw new GoalStoreBusyError(filePath, waitedMs, error);
			}
			const delayMs = Math.min(
				FILE_STORAGE_LOCK_RETRY_MIN_DELAY_MS * 2 ** attempt,
				FILE_STORAGE_LOCK_RETRY_MAX_DELAY_MS,
				FILE_STORAGE_LOCK_RETRY_BUDGET_MS - waitedMs,
			);
			attempt += 1;
			await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
		}
	}
}

/**
 * Serializes a goal mutation both within and across processes.
 *
 * The in-process promise tail (serializeByKey) runs first, ensuring only one
 * cross-process lock acquire is in flight per key per process. The file lock
 * then guards the read-modify-write against concurrent processes.
 */
export function withGoalFileLock<T>(ref: GoalStoreRef, fn: () => Promise<T>): Promise<T> {
	const filePath = goalFilePath(ref);
	return serializeByKey(filePath, async () => {
		const { release, throwIfCompromised } = await acquireGoalLock(filePath, goalLockFilePath(ref));
		try {
			throwIfCompromised();
			const result = await fn();
			throwIfCompromised();
			return result;
		} finally {
			try {
				await release();
			} catch {
				// Ignore unlock errors (lock may have been compromised or cleaned up).
			}
		}
	});
}
