import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { createFsWatchEventSource } from "../../src/core/extensions/builtin/config-reload/watch-event-source.ts";

class GatedWorker extends EventEmitter {
	readonly commands: unknown[] = [];
	readonly exit = Promise.withResolvers<number>();
	postMessage(command: unknown): void {
		this.commands.push(command);
	}
	terminate(): Promise<number> {
		return this.exit.promise;
	}
}

// #1656: the worker source itself executes; only IPC delivery and native fs.watch are controlled.
describe("config watch worker shutdown", () => {
	it.each(["queued", "admitted"] as const)(
		"leaves no watcher when cancellation overtakes registration (%s)",
		async (phase) => {
			// Given: the production worker handler, paused before IPC delivery.
			const source = await readFile(
				new URL("../../src/core/extensions/builtin/config-reload/watch-event-source.ts", import.meta.url),
				"utf8",
			);
			const executable = source.match(/const RECURSIVE_WATCH_WORKER_SOURCE = `([\s\S]*?)`;/)?.[1];
			if (!executable) throw new Error("Worker entry source unavailable");
			const port = new EventEmitter();
			let registrations = 0;
			let cancel = () => {};
			runInNewContext(executable, {
				Atomics,
				require: (specifier: string) => {
					switch (specifier) {
						case "node:fs":
							return {
								watch: () => {
									if (phase === "admitted") cancel();
									registrations++;
									return Object.assign(new EventEmitter(), {
										close: () => {
											registrations--;
										},
									});
								},
							};
						case "node:worker_threads":
							return { parentPort: port };
						default:
							throw new Error(`Unexpected worker import: ${specifier}`);
					}
				},
			});
			const worker = new GatedWorker();
			const subscribe = createFsWatchEventSource(undefined, {
				platform: "darwin",
				createRecursiveWorker: () => worker,
			});
			const unsubscribe = subscribe("/queued-watch", () => {});
			cancel = () => {
				void unsubscribe();
			};
			try {
				// When: cancellation precedes dispatch or lands after admission inside fs.watch.
				// Snapshot IPC so an unwatch posted from inside fs.watch is not also delivered;
				// the post-watch cancellation check must dispose that handle itself.
				if (phase === "queued") cancel();
				const dispatched = worker.commands.splice(0);
				for (const command of dispatched) port.emit("message", command);
				worker.exit.resolve(0);
				await unsubscribe();
				// Then: late registration is immediately disposed, never retained for delivery.
				expect(registrations).toBe(0);
			} finally {
				worker.exit.resolve(0);
			}
		},
	);

	it("returns the native termination join on repeated final unsubscribe", async () => {
		// Given: termination cannot finish until the explicit release.
		const worker = new GatedWorker();
		const subscribe = createFsWatchEventSource(undefined, {
			platform: "darwin",
			createRecursiveWorker: () => worker,
		});
		const unsubscribe = subscribe("/queued-watch", () => {});
		try {
			// When: the final unsubscribe is requested repeatedly.
			const first = unsubscribe();
			const second = unsubscribe();
			// Then: both callers own the same pending native teardown.
			expect(first).toBeInstanceOf(Promise);
			expect(second).toBe(first);
			worker.exit.resolve(0);
			await first;
		} finally {
			worker.exit.resolve(0);
		}
	});
});
