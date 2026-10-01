import { once } from "node:events";
import http from "node:http";
import workerThreads from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { cleanupFailures, observeResources } from "../../scripts/gate-resources.ts";

describe("owned runtime teardown observation", () => {
	it("names a leaked host listener even when no worker or socket is open", async () => {
		// Given: the host process outlives every runtime resource.
		const resources = observeResources();
		const listener = () => undefined;
		process.on("beforeExit", listener);
		try {
			// When / Then
			expect(cleanupFailures(await resources.counts(), "host")).toContain("cleanup host: listeners=1");
		} finally {
			process.off("beforeExit", listener);
			resources.restore();
		}
	});
	it("names a live worker and returns to zero after its actual exit", async () => {
		// Given: constructor instrumentation in an isolated test process.
		const resources = observeResources();
		const worker = new workerThreads.Worker('require("node:worker_threads").parentPort.on("message", () => {});', {
			eval: true,
		});
		try {
			// When: measure before the worker exits.
			const live = await resources.counts();
			// Then: a close() boolean cannot hide this live worker.
			expect(cleanupFailures(live, "fixture")).toContain("cleanup fixture: workers=1");
		} finally {
			await worker.terminate();
			expect(cleanupFailures(await resources.counts(), "fixture")).toEqual([]);
			resources.restore();
		}
	});

	it("counts an open server and a pending subscription until both are released", async () => {
		// Given: real open handle and event-ordered pending host call.
		const resources = observeResources();
		const server = http.createServer();
		const listening = once(server, "listening");
		server.listen(0, "127.0.0.1");
		await listening;
		const pending = Promise.withResolvers<void>();
		const subscription = resources.subscribe(pending.promise);
		try {
			// When
			const live = await resources.counts();
			// Then
			expect(cleanupFailures(live, "fixture")).toEqual(
				expect.arrayContaining(["cleanup fixture: handles=1", "cleanup fixture: subscriptions=1"]),
			);
		} finally {
			const closed = once(server, "close");
			server.close();
			await closed;
			pending.resolve();
			await subscription;
			expect(cleanupFailures(await resources.counts(), "fixture")).toEqual([]);
			resources.restore();
		}
	});
});
