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
 */
import { readHostCrashRecords } from "./host-crash-record.ts";
import { hostDaemonDirectoryPaths } from "./host-daemon-paths.ts";
import { type HostEndpointEntry, type HostEndpointIdentitySource, listHostEndpoints } from "./host-endpoints.ts";
import { readGenerationRows } from "./host-generations.ts";
import { type HostStatusReport, readHostStatus } from "./host-status.ts";
import { readClaimRows } from "./host-status-rows.ts";

/** Endpoints read at once: bounded, because each one is a socket probe plus a directory walk. */
const STATUS_ALL_CONCURRENCY = 4;

export interface HostEndpointStatus extends Omit<HostStatusReport, "socket"> {
	readonly socket: string | null;
	readonly dir: string;
	readonly identity: HostEndpointIdentitySource;
}

export async function readAllHostStatus(options: {
	readonly agentDir: string;
	readonly includeWorkers: boolean;
}): Promise<readonly HostEndpointStatus[]> {
	const endpoints = await listHostEndpoints(options.agentDir);
	const rows: HostEndpointStatus[] = new Array(endpoints.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		for (let index = next++; index < endpoints.length; index = next++) {
			const endpoint = endpoints[index];
			if (endpoint !== undefined) rows[index] = await endpointStatus(endpoint, options);
		}
	};
	await Promise.all(Array.from({ length: Math.min(STATUS_ALL_CONCURRENCY, endpoints.length) }, worker));
	return rows;
}

async function endpointStatus(
	endpoint: HostEndpointEntry,
	options: { readonly agentDir: string; readonly includeWorkers: boolean },
): Promise<HostEndpointStatus> {
	const located = { dir: endpoint.dir, identity: endpoint.identity };
	if (endpoint.socket === null) return { ...(await unaddressableStatus(endpoint.dir)), socket: null, ...located };
	const report = await readHostStatus(
		{ socket: endpoint.socket, agentDir: options.agentDir, includeWorkers: options.includeWorkers },
		{ prune: false },
	);
	return { ...report, ...located };
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
		env_keys: [],
		generations,
		crashes: readHostCrashRecords(dir).length,
		shard: null,
		session_rows: [],
		claims_live: claims.filter((claim) => claim.live).length,
		claims: [],
	};
}
