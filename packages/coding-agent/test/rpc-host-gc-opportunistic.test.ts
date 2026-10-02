/**
 * The budgeted gc pass `ensureHost` schedules once it has returned a host: dead endpoint records under
 * the agent directory are reaped on `host gc`'s own three-part evidence without an operator command,
 * the ensure itself resolves before the pass removes anything, and the target endpoint is never judged.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readProcessStartTime } from "../src/modes/app-server/daemon/process.ts";
import { createHostDaemonPaths, generationPaths } from "../src/modes/rpc/host-daemon-paths.ts";
import { probeHost } from "../src/modes/rpc/host-probe.ts";
import { endpointScratch, heldRealHost, sweepEndpointScratches } from "./helpers/rpc-host-endpoint-scratch.ts";
import { deadEndpoint, writeJson } from "./helpers/rpc-host-gc-fixtures.ts";
import { fileWritten, gcMarkerPath, readGcMarker } from "./helpers/rpc-host-gc-pass-fixtures.ts";

afterEach(sweepEndpointScratches, 180_000);

describe.skipIf(process.platform === "win32")("budgeted gc pass scheduled by ensure", () => {
	it("returns the host before removing anything, then reaps at most 32 dead records and leaves live and target alone", async () => {
		const qa = endpointScratch("ogc");
		const deadDirs: string[] = [];
		for (let index = 0; index < 40; index += 1) {
			deadDirs.push((await deadEndpoint(join(qa.root, "d", `e${index}.sock`), qa.agentDir)).dir);
		}
		const live = await deadEndpoint(join(qa.root, "d", "live.sock"), qa.agentDir);
		const startTime = await readProcessStartTime(process.pid);
		await writeJson(generationPaths(live, "g-live").pidFile, { pid: process.pid, processStartTime: startTime });
		const target = createHostDaemonPaths({ socket: qa.legacy, agentDir: qa.agentDir });

		let presentAtResolution = -1;
		const host = await heldRealHost(qa, qa.legacy).then((ensured) => {
			// Synchronous on purpose: no event-loop turn may run between the settle and this count.
			presentAtResolution = deadDirs.filter((dir) => existsSync(dir)).length;
			return ensured;
		});
		host.release();
		expect(presentAtResolution).toBe(40);

		await fileWritten(gcMarkerPath(qa.agentDir), 10_000);
		const marker = await readGcMarker(qa.agentDir);
		const remaining = deadDirs.filter((dir) => existsSync(dir)).length;
		const removed = 40 - remaining;
		expect(removed).toBeGreaterThan(0);
		expect(removed).toBeLessThanOrEqual(32);
		expect(marker.removed).toBe(removed);
		if (marker.stoppedBy === "count") expect(removed).toBe(32);
		expect(existsSync(live.endpointFile)).toBe(true);
		expect(existsSync(target.endpointFile)).toBe(true);
		expect(readdirSync(target.generationsDir)).not.toHaveLength(0);
		expect(await probeHost({ socket: qa.legacy })).toBeDefined();
	}, 180_000);
});
