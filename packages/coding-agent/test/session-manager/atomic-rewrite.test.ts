import type * as FsModule from "node:fs";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

/**
 * A disk that fills part-way through a write: descriptor writes succeed until the
 * byte budget runs out, the write that crosses it lands only its leading bytes, and
 * then fails with ENOSPC, the way a full volume answers a large write.
 */
const disk = vi.hoisted(() => {
	const state = { bytesLeft: Number.POSITIVE_INFINITY };
	function withBudget(actual: typeof FsModule): typeof FsModule {
		const writeFileSync: typeof actual.writeFileSync = (file, data, options) => {
			if (typeof file !== "number" || state.bytesLeft === Number.POSITIVE_INFINITY) {
				actual.writeFileSync(file, data, options);
				return;
			}
			const bytes =
				typeof data === "string" ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
			if (bytes.length <= state.bytesLeft) {
				state.bytesLeft -= bytes.length;
				actual.writeFileSync(file, bytes, options);
				return;
			}
			actual.writeSync(file, bytes, 0, state.bytesLeft);
			state.bytesLeft = 0;
			throw Object.assign(new Error("ENOSPC: no space left on device, write"), {
				code: "ENOSPC",
				errno: -28,
				syscall: "write",
			});
		};
		return { ...actual, writeFileSync };
	}
	return { state, withBudget };
});

vi.mock("fs", async (importOriginal) => disk.withBudget(await importOriginal<typeof FsModule>()));
vi.mock("node:fs", async (importOriginal) => disk.withBudget(await importOriginal<typeof FsModule>()));

const LEGACY_V2_HEADER = {
	type: "session",
	version: 2,
	id: "legacy-session",
	timestamp: "2025-01-01T00:00:00Z",
	cwd: "/tmp",
};

const LEGACY_V2_MESSAGES = [
	{
		type: "message",
		id: "aaaa1111",
		parentId: null,
		timestamp: "2025-01-01T00:00:01Z",
		message: { role: "user", content: "hello", timestamp: 1 },
	},
	{
		type: "message",
		id: "bbbb2222",
		parentId: "aaaa1111",
		timestamp: "2025-01-01T00:00:02Z",
		message: { role: "hookMessage", customType: "note", content: "x".repeat(8192), display: true, timestamp: 2 },
	},
];

function serialize(lines: readonly unknown[]): string {
	return lines.map((line) => `${JSON.stringify(line)}\n`).join("");
}

describe("SessionManager whole-file rewrite", () => {
	let dir: string;
	let file: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "session-atomic-rewrite-"));
		file = join(dir, "legacy.jsonl");
		writeFileSync(file, serialize([LEGACY_V2_HEADER, ...LEGACY_V2_MESSAGES]));
	});

	afterEach(() => {
		disk.state.bytesLeft = Number.POSITIVE_INFINITY;
		rmSync(dir, { recursive: true, force: true });
	});

	it("keeps an old-version transcript byte-identical when the migration rewrite fails part-way", () => {
		// Given a version-2 transcript on a disk with room for only part of the rewrite
		const original = readFileSync(file);
		disk.state.bytesLeft = 1024;

		// When opening it runs the version migration and the disk fills mid-write
		let failure: unknown;
		try {
			SessionManager.open(file, dir);
		} catch (error) {
			failure = error;
		}

		// Then the write error reaches the caller, the original transcript is untouched, and no temp file is left
		expect(failure).toMatchObject({ code: "ENOSPC" });
		expect(readFileSync(file).equals(original)).toBe(true);
		expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("writes the migrated transcript with the exact in-place bytes and keeps the file mode", () => {
		// Given a version-2 transcript readable only by its owner
		chmodSync(file, 0o600);
		const expected = serialize([
			{ ...LEGACY_V2_HEADER, version: 3 },
			...LEGACY_V2_MESSAGES.map((line) =>
				line.message.role === "hookMessage" ? { ...line, message: { ...line.message, role: "custom" } } : line,
			),
		]);

		// When opening it migrates the file to the current version
		const session = SessionManager.open(file, dir);

		// Then the rewrite produced exactly the serialized migrated entries, same mode, no temp file
		expect(session.getHeader()?.version).toBe(3);
		expect(readFileSync(file, "utf8")).toBe(expected);
		if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});
});
