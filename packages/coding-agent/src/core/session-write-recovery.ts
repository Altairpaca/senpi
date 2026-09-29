import { closeSync, fstatSync, ftruncateSync, openSync, readSync, rmSync } from "node:fs";

const NEWLINE = 0x0a;
const SCAN_CHUNK_BYTES = 64 * 1024;

/**
 * Cuts a JSONL session file back to its last complete line. An append that failed part-way
 * (ENOSPC) can leave a partial line, and the next append would be glued onto it, losing both
 * entries on reload. A file that already ends in a newline is left untouched.
 */
export function truncateToLastCompleteLine(path: string): void {
	const fd = openSync(path, "r+");
	try {
		const size = fstatSync(fd).size;
		const chunk = Buffer.alloc(Math.min(SCAN_CHUNK_BYTES, size));
		let end = size;
		while (end > 0) {
			const start = Math.max(0, end - chunk.length);
			const read = readSync(fd, chunk, 0, end - start, start);
			const newline = chunk.subarray(0, read).lastIndexOf(NEWLINE);
			if (newline >= 0) {
				const completeLength = start + newline + 1;
				if (completeLength < size) ftruncateSync(fd, completeLength);
				return;
			}
			end = start;
		}
	} finally {
		closeSync(fd);
	}
}

/**
 * Removes a session file whose first flush failed part-way, then rethrows the write error. The
 * first flush creates the file exclusively, so a partial file left behind would fail every later
 * flush with EEXIST while memory kept growing.
 */
export function discardFailedFirstFlush(path: string, writeError: unknown): never {
	try {
		rmSync(path, { force: true });
	} catch (cleanupError) {
		throw new AggregateError(
			[writeError, cleanupError],
			`Session file write failed and the partial file ${path} could not be removed`,
		);
	}
	throw writeError;
}
