/**
 * `status --all` against endpoints that accept a connection and never answer: every endpoint is
 * probed at once under its own budget, so a machine with several hung hosts answers in about one
 * budget rather than one per host, and the rows keep the enumeration order.
 */
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemonDirectories, createHostDaemonPaths } from "../src/modes/rpc/host-daemon-paths.ts";
import { listHostEndpoints } from "../src/modes/rpc/host-endpoints.ts";
import { readAllHostStatus } from "../src/modes/rpc/host-status-all.ts";
import { endpointScratch, sweepEndpointScratches } from "./helpers/rpc-host-endpoint-scratch.ts";
import { closeServer } from "./helpers/rpc-host-gc-fixtures.ts";

const servers: Server[] = [];
const held: Socket[] = [];

afterEach(async () => {
	for (const connection of held.splice(0)) connection.destroy();
	for (const server of servers.splice(0)) await closeServer(server);
	await sweepEndpointScratches();
}, 180_000);

const SILENT_ENDPOINTS = 8;
const BUDGET_MS = 2_000;

async function silentEndpoint(socket: string, agentDir: string): Promise<void> {
	const server = createServer((connection) => held.push(connection));
	await new Promise<void>((listening, reject) => {
		server.once("error", reject);
		server.listen(socket, () => listening());
	});
	servers.push(server);
	await createDaemonDirectories(createHostDaemonPaths({ socket, agentDir }));
}

describe.skipIf(process.platform === "win32")("host status --all against silent endpoints", () => {
	it("reads every hung endpoint at once, in about one probe budget, in enumeration order", async () => {
		const qa = endpointScratch("silent");
		const sockets = Array.from({ length: SILENT_ENDPOINTS }, (_, index) => join(qa.root, `s${index}.sock`));
		for (const socket of sockets) await silentEndpoint(socket, qa.agentDir);
		const listed = await listHostEndpoints(qa.agentDir);

		const started = Date.now();
		const rows = await readAllHostStatus({ agentDir: qa.agentDir, includeWorkers: true, timeoutMs: BUDGET_MS });
		const elapsed = Date.now() - started;

		expect(rows.map((row) => row.dir)).toEqual(listed.map((endpoint) => endpoint.dir));
		expect(new Set(rows.map((row) => row.socket))).toEqual(new Set(sockets));
		for (const row of rows) expect(row).toMatchObject({ reachable: false, session_rows: [] });
		// Serial reads would take SILENT_ENDPOINTS budgets (twice that with the listing asked too).
		expect(elapsed).toBeGreaterThanOrEqual(BUDGET_MS);
		expect(elapsed).toBeLessThan(2.5 * BUDGET_MS);
	}, 180_000);
});
