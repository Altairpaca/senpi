import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createInternalSocketPath } from "../../../src/modes/rpc/host-lifecycle.ts";

// Regression coverage for https://github.com/code-yeongyu/senpi/issues/1370
describe("createInternalSocketPath", () => {
	const created: string[] = [];

	afterEach(() => {
		for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("creates the win32 internal directory when rpc-host-daemon does not exist yet", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "senpi-hlc-win32-"));
		created.push(agentDir);
		const daemonDir = join(agentDir, "rpc-host-daemon");
		expect(existsSync(daemonDir)).toBe(false);

		const internal = await createInternalSocketPath(daemonDir, "win32");

		const dir = internal.dir;
		if (dir === undefined) throw new Error("expected an internal socket directory");
		expect(existsSync(dir)).toBe(true);
		expect(dirname(dir)).toBe(daemonDir);
		expect(internal.socket.startsWith("\\\\.\\pipe\\")).toBe(true);
		expect(internal.secretPath).toBe(join(dir, "secret"));
	});

	it("keeps the posix internal directory in the OS temp dir", async () => {
		const internal = await createInternalSocketPath(join(tmpdir(), "senpi-hlc-unused"), "linux");

		const dir = internal.dir;
		if (dir === undefined) throw new Error("expected an internal socket directory");
		created.push(dir);
		expect(existsSync(dir)).toBe(true);
		expect(dirname(dir)).toBe(tmpdir());
		expect(internal.socket).toBe(join(dir, "host.sock"));
	});
});
