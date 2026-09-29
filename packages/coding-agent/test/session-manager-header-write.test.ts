import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";

const hooks = vi.hoisted(() => ({ beforeClose: undefined as (() => void) | undefined }));

vi.mock("fs/promises", async (importOriginal) => {
	const real = await importOriginal<typeof import("fs/promises")>();
	return {
		...real,
		open: async (...args: Parameters<typeof real.open>) => {
			const handle = await real.open(...args);
			const close = handle.close.bind(handle);
			handle.close = async () => {
				hooks.beforeClose?.();
				await close();
			};
			return handle;
		},
	};
});

const roots: string[] = [];

afterEach(() => {
	hooks.beforeClose = undefined;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("persistHeaderNow's asynchronous header write", () => {
	it("writes the entries persisted while its file handle closes before the transcript counts as flushed", async () => {
		const root = mkdtempSync(join(tmpdir(), "senpi-header-write-"));
		roots.push(root);
		const manager = SessionManager.create(root, join(root, "sessions"));
		const file = manager.getSessionFile();
		if (file === undefined) throw new Error("no session file");
		manager.appendCustomEntry("before", { n: 0 });
		hooks.beforeClose = () => {
			hooks.beforeClose = undefined;
			manager.appendCustomEntry("during-close", { n: 1 });
		};
		await manager.persistHeaderNow();
		expect(manager.isTranscriptFlushed()).toBe(true);
		manager.appendCustomEntry("after", { n: 2 });
		const lines = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines.map((line) => (line.type === "session" ? "session" : line.customType))).toEqual([
			"session",
			"before",
			"during-close",
			"after",
		]);
	});
});
