/**
 * `senpi host gc`: reclaims the endpoint directories of hosts that are PROVABLY gone, and nothing else.
 *
 * Endpoint state accumulates by design - `endpoint.json` outlives every generation so `status --all`
 * can still name an endpoint whose host exited - and this is the only path that ever removes it. It
 * never runs implicitly (not inside `ensure`, not inside `status`), it never signals a process, and it
 * removes an endpoint only on three-part evidence evaluated INSIDE that endpoint's ensure lock, the one
 * `ensureHost` serializes on (`hostEnsureLockTarget`), so an ensure can neither start a host into a
 * directory being removed nor have its fresh registration removed under it. Every endpoint that fails
 * any part of the evidence is kept, with the reason:
 *
 *     live_generation   a generation pidfile (any, the pointer's included) names a live process
 *     live_claim        a session-path claim in `reservations/` has a live owner
 *     reachable         the socket (or a `.next-*` successor bind) did not refuse the connection
 *     locked            the ensure lock was not free within 2 s
 *     legacy_layout     the agent dir predates layout 2; its flat files belong to a legacy host
 *     unknown_identity  nothing in the directory names its socket, so its lock cannot be taken
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HOST_DAEMON_LAYOUT, hostDaemonDirectoryPaths } from "./host-daemon-paths.ts";
import { parseJson, readFileOrUndefined } from "./host-daemon-state.ts";
import { listHostEndpoints } from "./host-endpoints.ts";
import { hostEnsureLockTarget } from "./host-ensure.ts";
import { type EndpointInUse, endpointInUse, type SocketSilence, socketSiblings } from "./host-gc-evidence.ts";
import { acquireOwnershipSafeLock } from "./ownership-safe-lock.ts";

export type HostGcKeptReason = EndpointInUse | "locked" | "legacy_layout" | "unknown_identity";

export interface HostGcEntry<Reason extends string> {
	readonly socket: string | null;
	readonly dir: string;
	readonly reason: Reason;
}

export interface HostGcResult {
	readonly removed: readonly HostGcEntry<SocketSilence>[];
	readonly kept: readonly HostGcEntry<HostGcKeptReason>[];
}

export interface HostGcOptions {
	readonly _test?: {
		/** Runs inside an endpoint's ensure lock, before any evidence is read. */
		readonly afterLockAcquired?: (socket: string) => Promise<void>;
	};
}

/** 2 s, the budget a concurrent ensure's critical section gets before gc reports `locked`. */
const GC_LOCK_OPTIONS = { retries: { retries: 20, minTimeout: 20, maxTimeout: 100 } } as const;

export async function gcHostEndpoints(agentDir: string, options: HostGcOptions = {}): Promise<HostGcResult> {
	const removed: HostGcEntry<SocketSilence>[] = [];
	const kept: HostGcEntry<HostGcKeptReason>[] = [];
	const legacy = await legacyFlatDirectory(agentDir);
	if (legacy !== undefined) kept.push({ socket: null, dir: legacy, reason: "legacy_layout" });
	for (const endpoint of await listHostEndpoints(agentDir)) {
		if (endpoint.socket === null) {
			kept.push({ socket: null, dir: endpoint.dir, reason: "unknown_identity" });
			continue;
		}
		const outcome = await gcEndpoint(endpoint.socket, endpoint.dir, options);
		if (outcome.removed) removed.push({ socket: endpoint.socket, dir: endpoint.dir, reason: outcome.reason });
		else kept.push({ socket: endpoint.socket, dir: endpoint.dir, reason: outcome.reason });
	}
	return { removed, kept };
}

async function gcEndpoint(
	socket: string,
	dir: string,
	options: HostGcOptions,
): Promise<
	| { readonly removed: true; readonly reason: SocketSilence }
	| { readonly removed: false; readonly reason: HostGcKeptReason }
> {
	const release = await acquireEnsureLock(socket);
	if (release === undefined) return { removed: false, reason: "locked" };
	try {
		await options._test?.afterLockAcquired?.(socket);
		const evidence = await endpointInUse(hostDaemonDirectoryPaths(dir), socket);
		if (evidence.inUse !== undefined) return { removed: false, reason: evidence.inUse };
		await rm(dir, { recursive: true, force: true });
		for (const sibling of await socketSiblings(socket)) await rm(join(dirname(socket), sibling), { force: true });
		await rm(socket, { force: true });
		return { removed: true, reason: evidence.silence };
	} finally {
		await release();
	}
}

/** The ensure lock of `socket`, taken exactly as `ensureHost` takes it; `undefined` when not free in time. */
async function acquireEnsureLock(socket: string): Promise<(() => Promise<void>) | undefined> {
	const lockTarget = hostEnsureLockTarget(socket);
	await mkdir(dirname(lockTarget), { recursive: true });
	await writeFile(lockTarget, "", { flag: "a", mode: 0o600 });
	return acquireOwnershipSafeLock(`${lockTarget}.lock`, GC_LOCK_OPTIONS).catch(() => undefined);
}

/** The flat daemon directory when it holds state but no layout-2 marker: a legacy host's, never touched. */
async function legacyFlatDirectory(agentDir: string): Promise<string | undefined> {
	const flatDir = join(agentDir, "rpc-host-daemon");
	const marker = parseJson(await readFileOrUndefined(join(flatDir, "layout.json")).catch(() => undefined));
	if (marker?.layout === HOST_DAEMON_LAYOUT) return undefined;
	const hasState = (await readFileOrUndefined(join(flatDir, "host.pid")).catch(() => undefined)) !== undefined;
	return hasState ? flatDir : undefined;
}
