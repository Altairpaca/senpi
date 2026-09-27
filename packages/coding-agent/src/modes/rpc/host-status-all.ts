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

export interface HostEndpointStatus extends Omit<HostStatusReport, "socket"> {
	readonly socket: string | null;
	readonly dir: string;
	readonly identity: HostEndpointIdentitySource;
}

interface StatusAllOptions {
	readonly agentDir: string;
	readonly includeWorkers: boolean;
	/** Budget for each read of each endpoint's socket, default 10 s (`readHostStatus`). */
	readonly timeoutMs?: number;
}

/**
 * Every endpoint is read at once, each under its own budget, so hung hosts cost about one budget in
 * total rather than one each; rows keep the enumeration order (sorted by directory name).
 */
export async function readAllHostStatus(options: StatusAllOptions): Promise<readonly HostEndpointStatus[]> {
	const endpoints = await listHostEndpoints(options.agentDir);
	return Promise.all(endpoints.map((endpoint) => endpointStatus(endpoint, options)));
}

async function endpointStatus(endpoint: HostEndpointEntry, options: StatusAllOptions): Promise<HostEndpointStatus> {
	const located = { dir: endpoint.dir, identity: endpoint.identity };
	if (endpoint.socket === null) return { ...(await unaddressableStatus(endpoint.dir)), socket: null, ...located };
	const report = await readHostStatus(
		{ socket: endpoint.socket, agentDir: options.agentDir, includeWorkers: options.includeWorkers },
		{ prune: false, ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) },
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
