import { resolve } from "node:path";
import { realpathWithoutOpen } from "../../utils/paths.ts";

const fileMutationQueues = new Map<string, Promise<void>>();
let registrationQueue = Promise.resolve();

/**
 * Two paths that name the same file must produce the same key, and a path that does not exist yet
 * keys on its resolved form. Resolution walks lstat/readlink instead of realpath so it never
 * open(2)-s a component: a target under a wedged mount would otherwise stall every write and edit.
 */
async function getMutationQueueKey(filePath: string): Promise<string> {
	return realpathWithoutOpen(resolve(filePath));
}

/**
 * Serialize file mutation operations targeting the same file.
 * Operations for different files still run in parallel.
 */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const registration = registrationQueue.then(async () => {
		const key = await getMutationQueueKey(filePath);
		const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

		let releaseNext!: () => void;
		const nextQueue = new Promise<void>((resolveQueue) => {
			releaseNext = resolveQueue;
		});
		const chainedQueue = currentQueue.then(() => nextQueue);
		fileMutationQueues.set(key, chainedQueue);

		return { key, currentQueue, chainedQueue, releaseNext };
	});
	registrationQueue = registration.then(
		() => undefined,
		() => undefined,
	);

	const { key, currentQueue, chainedQueue, releaseNext } = await registration;
	await currentQueue;
	try {
		return await fn();
	} finally {
		releaseNext();
		if (fileMutationQueues.get(key) === chainedQueue) {
			fileMutationQueues.delete(key);
		}
	}
}
