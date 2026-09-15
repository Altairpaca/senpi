import { Worker } from "node:worker_threads";
import { watchWithErrorHandler } from "../../../../utils/fs-watch.ts";
import type { WatchEventListener, WatchEventSource } from "./watch-engine.ts";

export interface RecursiveWatchWorker {
	on(event: "message", listener: (message: unknown) => void): this;
	on(event: "error", listener: (error: Error) => void): this;
	postMessage(message: unknown): void;
	terminate(): Promise<number>;
}

export type RecursiveWatchWorkerFactory = () => RecursiveWatchWorker;

export type FsWatchEventSourceOptions = {
	readonly platform?: NodeJS.Platform;
	readonly createRecursiveWorker?: RecursiveWatchWorkerFactory;
};

type RecursiveWatchMessage =
	| { readonly kind: "event"; readonly id: number; readonly eventType: string; readonly filename: string | null }
	| { readonly kind: "error"; readonly id: number; readonly message: string };

const RECURSIVE_WATCH_WORKER_SOURCE = `
const { watch } = require("node:fs");
const { parentPort } = require("node:worker_threads");

if (!parentPort) throw new Error("Recursive watch worker requires a parent port");

const watchers = new Map();
const cancelled = new Set();
const isCancelled = (message) =>
	cancelled.has(message.id) || (message.active !== undefined && Atomics.load(message.active, 0) === 0);
parentPort.on("message", (message) => {
	if (message.kind === "unwatch") {
		cancelled.add(message.id);
		watchers.get(message.id)?.close();
		watchers.delete(message.id);
		return;
	}
	if (message.kind !== "watch") return;
	if (isCancelled(message)) return;
	try {
		const watcher = watch(
			message.path,
			{ recursive: message.recursive !== false, encoding: "utf8" },
			(eventType, filename) => {
				if (isCancelled(message)) return;
				parentPort.postMessage({
					kind: "event",
					id: message.id,
					eventType,
					filename: typeof filename === "string" ? filename : null,
				});
			},
		);
		if (isCancelled(message)) {
			watcher.close();
			return;
		}
		watcher.on("error", (error) => {
			parentPort.postMessage({
				kind: "error",
				id: message.id,
				message: error instanceof Error ? error.message : String(error),
			});
		});
		watchers.set(message.id, watcher);
	} catch (error) {
		parentPort.postMessage({
			kind: "error",
			id: message.id,
			message: error instanceof Error ? error.message : String(error),
		});
	}
});
`;

function createRecursiveWatchWorker(): RecursiveWatchWorker {
	return new Worker(RECURSIVE_WATCH_WORKER_SOURCE, {
		eval: true,
	});
}

function isRecursiveWatchMessage(message: unknown): message is RecursiveWatchMessage {
	if (typeof message !== "object" || message === null || !("kind" in message)) return false;
	if (!("id" in message) || typeof message.id !== "number") return false;
	if (message.kind === "error") return "message" in message && typeof message.message === "string";
	return (
		message.kind === "event" &&
		"eventType" in message &&
		typeof message.eventType === "string" &&
		"filename" in message &&
		(message.filename === null || typeof message.filename === "string")
	);
}

/**
 * Platforms whose fs.watch handles are expensive to create and tear down on the
 * interactive main thread: inotify tree walks on Linux, FSEvents stream rendezvous on
 * macOS. Non-recursive per-directory watches pay the same FSEvents setup latency —
 * measured 2.7-8.0s per watch-engine target under system load — so every watch is
 * offloaded, not only recursive ones.
 */
const WORKER_OFFLOADED_WATCH_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(["linux", "darwin"]);

/** Production event source. Watch setup and teardown run off the interactive main thread. */
export function createFsWatchEventSource(
	onError: (error: unknown, path: string) => void = () => {},
	options: FsWatchEventSourceOptions = {},
): WatchEventSource {
	const recursiveSubscriptions = new Map<
		number,
		{
			readonly path: string;
			readonly listener: WatchEventListener;
			readonly recursive: boolean;
			readonly active: Int32Array;
		}
	>();
	let recursiveWorker: RecursiveWatchWorker | undefined;
	let nextSubscriptionId = 1;

	const ensureRecursiveWorker = (): RecursiveWatchWorker => {
		if (recursiveWorker) return recursiveWorker;
		const worker = (options.createRecursiveWorker ?? createRecursiveWatchWorker)();
		worker.on("message", (message) => {
			if (!isRecursiveWatchMessage(message)) return;
			const subscription = recursiveSubscriptions.get(message.id);
			if (!subscription) return;
			if (message.kind === "event") {
				subscription.listener(message.eventType, message.filename);
				return;
			}
			onError(new Error(message.message), subscription.path);
		});
		worker.on("error", (error) => {
			for (const subscription of recursiveSubscriptions.values()) onError(error, subscription.path);
			// A worker that raised an uncaught error is dead; keeping it would leave every
			// live subscription silent. Drop it and move the survivors to a fresh worker.
			if (recursiveWorker !== worker) return;
			recursiveWorker = undefined;
			if (recursiveSubscriptions.size === 0) return;
			const replacement = ensureRecursiveWorker();
			for (const [id, subscription] of recursiveSubscriptions) {
				replacement.postMessage({
					kind: "watch",
					id,
					path: subscription.path,
					recursive: subscription.recursive,
					active: subscription.active,
				});
			}
		});
		recursiveWorker = worker;
		return worker;
	};

	return (path, listener, watchOptions) => {
		if (WORKER_OFFLOADED_WATCH_PLATFORMS.has(options.platform ?? process.platform)) {
			const id = nextSubscriptionId++;
			const recursive = watchOptions?.recursive ?? false;
			const active = new Int32Array(new SharedArrayBuffer(4));
			Atomics.store(active, 0, 1);
			ensureRecursiveWorker().postMessage({ kind: "watch", id, path, recursive, active });
			recursiveSubscriptions.set(id, { path, listener, recursive, active });
			let closing: Promise<void> | undefined;
			return () => {
				if (!recursiveSubscriptions.delete(id)) return closing;
				Atomics.store(active, 0, 0);
				// Resolve at unsubscribe time: the worker may have been replaced after a crash.
				const worker = recursiveWorker;
				if (!worker) return closing;
				worker.postMessage({ kind: "unwatch", id });
				if (recursiveSubscriptions.size > 0) return;
				recursiveWorker = undefined;
				closing = worker.terminate().then(
					() => undefined,
					(error: unknown) => {
						onError(error, path);
						throw error;
					},
				);
				return closing;
			};
		}

		const watcher = watchWithErrorHandler(
			path,
			listener,
			() => onError(new Error(`fs.watch failed for ${path}`), path),
			{ recursive: watchOptions?.recursive ?? false },
		);
		return () => watcher?.close();
	};
}
