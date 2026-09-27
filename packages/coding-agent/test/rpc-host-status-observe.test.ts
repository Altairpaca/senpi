/**
 * Looking at a host must not keep it alive: `senpi host status [--all]` reads are observing reads,
 * so a poller (a runtime panel, a doctor loop) leaves every endpoint's idle window running. The
 * supervisor-side classification is covered on a driven clock in `rpc-host-lifecycle.test.ts`; this
 * suite proves the whole path against a real supervised host and the real `status --all`.
 */
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { endpointScratch, realHost, statusAll, sweepEndpointScratches } from "./helpers/rpc-host-endpoint-scratch.ts";
import { waitForPidGone } from "./helpers/spawned-host-reaper.ts";

afterEach(sweepEndpointScratches, 180_000);

const IDLE_EXIT_MS = 3_000;
const POLL_INTERVAL_MS = 1_000;

describe.skipIf(process.platform === "win32")("host status reads and idle exit", () => {
	it("lets a host idle out on schedule while status --all polls it every second", async () => {
		const qa = endpointScratch("poll");
		const supervisor = await realHost(qa, qa.shard, { idleExitMs: IDLE_EXIT_MS });
		const ensuredAt = Date.now();
		let exited: boolean | undefined;
		const exit = waitForPidGone(supervisor, 10 * IDLE_EXIT_MS).then((gone) => {
			exited = gone;
		});
		let reachablePolls = 0;
		while (exited === undefined) {
			const { endpoints } = await statusAll(qa);
			if (endpoints.some((endpoint) => endpoint.reachable)) reachablePolls++;
			await Promise.race([exit, delay(POLL_INTERVAL_MS)]);
		}

		expect(exited).toBe(true);
		expect(reachablePolls).toBeGreaterThanOrEqual(2);
		expect(Date.now() - ensuredAt).toBeLessThan(IDLE_EXIT_MS + 10_000);
	}, 120_000);
});
