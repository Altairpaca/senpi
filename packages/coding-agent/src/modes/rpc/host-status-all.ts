/**
 * `senpi host status --all`: one status row per endpoint an agent directory holds state for.
 *
 * Enumeration is the daemon directory (`listHostEndpoints`), and every row is the single-socket
 * report read with `prune: false` - so this answer removes NOTHING. Dead generations stay visible as
 * `alive: false` rows, an endpoint whose host exited stays listed through its `endpoint.json`, and
 * the reclaiming of what ended is a separate, evidence-gated command rather than a side effect of
 * looking. A directory that names no socket still gets a row (`socket: null`), built from the
 * directory alone, because it is exactly what an operator asking "what is on this machine" needs to
 * see.
 *
 * Every row carries the endpoint's `endpoint_kind` and the liveness verdict (`host-endpoint-liveness.ts`)
 * as `alive` (routable) plus `reason` when it is not. A `tui` row is read under TUI_PROBE_TIMEOUT_MS
 * whatever budget the caller grants the hosts, so one suspended terminal costs the listing 1.5 s,
 * not 10.
 */
import { readHostCrashRecords } from "./host-crash-record.ts";
import { type EndpointKind, hostDaemonDirectoryPaths } from "./host-daemon-paths.ts";
import { type EndpointLiveness, endpointProbeTimeoutMs, judgeEndpointLiveness } from "./host-endpoint-liveness.ts";
import { type HostEndpointEntry, type HostEndpointIdentitySource, listHostEndpoints } from "./host-endpoints.ts";
import { readGenerationRows } from "./host-generations.ts";
import { type HostStatusReport, readHostStatus } from "./host-status.ts";
import { readClaimRows } from "./host-status-rows.ts";

export interface HostEndpointStatus extends Omit<HostStatusReport, "socket"> {
	readonly socket: string | null;
	readonly dir: string;
	readonly identity: HostEndpointIdentitySource;
	readonly endpoint_kind: EndpointKind;
	/** `true` exactly when the endpoint is routable: it answered with an instance its directory recorded. */
	readonly alive: boolean;
	/** Why a row is not alive: still running but not answering, or provably gone. `null` when alive. */
	readonly reason: Exclude<EndpointLiveness, "routable"> | null;
}

/**
 * Endpoints read at once. Each read holds a socket and a few files open until its budget runs out, so
 * an unbounded fan-out over hundreds of hung hosts hit EMFILE under a 256-descriptor hard limit and
 * returned no rows at all; up to this many hung hosts still cost about one budget in total.
 */
export const STATUS_ALL_MAX_IN_FLIGHT = 64;

interface StatusAllOptions {
	readonly agentDir: string;
	readonly includeWorkers: boolean;
	/** Budget for each read of each host endpoint's socket, default 10 s (`readHostStatus`); `tui` rows never exceed 1.5 s. */
	readonly timeoutMs?: number;
	/** Replaces the per-endpoint read; tests observe how many run at once. */
	readonly _test?: { readonly readEndpoint?: (endpoint: HostEndpointEntry) => Promise<HostEndpointStatus> };
}

/**
 * Endpoints are read concurrently, at most STATUS_ALL_MAX_IN_FLIGHT at a time, each under its own
 * budget, so hung hosts cost about one budget per STATUS_ALL_MAX_IN_FLIGHT rather than one each; rows
 * keep the enumeration order (sorted by directory name).
 */
export async function readAllHostStatus(options: StatusAllOptions): Promise<readonly HostEndpointStatus[]> {
	const endpoints = await listHostEndpoints(options.agentDir);
	const read = options._test?.readEndpoint ?? ((endpoint: HostEndpointEntry) => endpointStatus(endpoint, options));
	const rows: HostEndpointStatus[] = new Array(endpoints.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		for (let index = next++; index < endpoints.length; index = next++) {
			const endpoint = endpoints[index];
			if (endpoint !== undefined) rows[index] = await read(endpoint);
		}
	};
	await Promise.all(Array.from({ length: Math.min(STATUS_ALL_MAX_IN_FLIGHT, endpoints.length) }, worker));
	return rows;
}

async function endpointStatus(endpoint: HostEndpointEntry, options: StatusAllOptions): Promise<HostEndpointStatus> {
	const located = { dir: endpoint.dir, identity: endpoint.identity, endpoint_kind: endpoint.endpoint_kind };
	const paths = hostDaemonDirectoryPaths(endpoint.dir);
	if (endpoint.socket === null) {
		const verdict = livenessFields(await judgeEndpointLiveness(paths, undefined));
		return { ...(await unaddressableStatus(endpoint.dir)), socket: null, ...located, ...verdict };
	}
	const report = await readHostStatus(
		{ socket: endpoint.socket, agentDir: options.agentDir, includeWorkers: options.includeWorkers },
		{ prune: false, timeoutMs: endpointProbeTimeoutMs(endpoint.endpoint_kind, options.timeoutMs) },
	);
	const verdict = await judgeEndpointLiveness(paths, report.reachable ? report.instanceId : undefined);
	return { ...report, ...located, ...livenessFields(verdict) };
}

function livenessFields(verdict: EndpointLiveness): Pick<HostEndpointStatus, "alive" | "reason"> {
	return verdict === "routable" ? { alive: true, reason: null } : { alive: false, reason: verdict };
}

async function unaddressableStatus(dir: string): Promise<Omit<HostStatusReport, "socket">> {
	const paths = hostDaemonDirectoryPaths(dir);
	const generations = await readGenerationRows(paths, { includeDead: true });
	const claims = await readClaimRows(paths, generations);
	return {
		reachable: false,
		pid: null,
		instanceId: null,
		generation: null,
		engineVersion: null,
		capabilities: [],
		launchProfile: null,
		sessions: { total: 0, interactive: 0, worker: 0, retained: 0, foreign_attached: 0, foreign_retained: 0 },
		zombies: null,
		rss_mb: null,
		host_rss_mb: null,
		open_fds: null,
		memory_pressure: null,
		env_keys: [],
		generations,
		crashes: readHostCrashRecords(dir).length,
		shard: null,
		session_rows: [],
		claims_live: claims.filter((claim) => claim.live).length,
		claims: [],
	};
}
