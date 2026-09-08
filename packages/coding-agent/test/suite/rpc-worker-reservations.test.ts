import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, type open, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { WorkerSessionRegistry } from "../../src/modes/rpc/worker-session-registry.ts";
import { waitForFifoReader } from "./rpc-worker-host-support.ts";

it.each(["close", "deadline"])(
	"retains canonical ownership after %s until the blocked worker actually exits",
	async (action) => {
		const scratch = await mkdtemp(join(tmpdir(), "senpi-worker-reservation-"));
		const cwd = join(scratch, "cwd");
		const agentDir = join(scratch, "agent");
		await mkdir(cwd);
		await mkdir(agentDir);
		const fifo = join(scratch, "blocked.jsonl");
		const alias = join(scratch, "alias.jsonl");
		execFileSync("mkfifo", [fifo]);
		await symlink(fifo, alias);
		const canonicalFifo = await realpath(fifo);
		vi.stubEnv("PATH", "/usr/bin:/bin");
		const registry = new WorkerSessionRegistry({
			configuration: {
				parsed: parseArgs(["--mode", "rpc", "--no-extensions", "--no-skills", "--no-context-files"]),
				cwd,
				agentDir,
				appMode: "rpc",
			},
			closeGraceMs: 100,
			now: Date.now,
		});
		let gate: Awaited<ReturnType<typeof open>> | undefined;
		try {
			const opening = registry.openSession({ cwd, sessionPath: fifo }).then(
				() => "opened",
				() => "cancelled",
			);
			gate = await waitForFifoReader(fifo);
			const handle = registry.list().find((entry) => entry.sessionPath === canonicalFifo)?.sessionId;
			if (!handle) throw new Error("Blocked worker is missing");
			const worker = registry.peek(handle)?.worker;
			if (!worker) throw new Error("Worker is missing");
			let exited = false;
			const exit = worker.exited.then(() => {
				exited = true;
			});
			if (action === "close") await registry.close(handle);
			else expect(await opening).toBe("cancelled");
			expect(exited).toBe(false);
			expect(registry.peek(handle)?.state).toBe("quarantined");
			const published = registry.list();
			expect(published.find((entry) => entry.sessionId === handle)?.status).toBe("closing");
			// Match the desktop eagerReattach predicate, not an expanded private state enum.
			expect(published.some((entry) => entry.sessionPath === canonicalFifo && entry.status !== "closing")).toBe(
				false,
			);
			expect(registry.size).toBeGreaterThan(0);
			await expect(registry.openSession({ cwd, sessionPath: alias })).rejects.toThrow("session_path_in_use");
			const header = `${JSON.stringify({ type: "session", version: 3, id: "retry-durable", timestamp: new Date(0).toISOString(), cwd })}\n`;
			await unlink(fifo);
			await writeFile(fifo, header);
			await gate.write(header);
			await gate.close();
			gate = undefined;
			await exit;
			expect(await opening).toBe("cancelled");
			const retry = await registry.openSession({ cwd, sessionPath: alias });
			expect(retry.durableSessionId).toBe("retry-durable");
			expect(retry.sessionId).not.toBe(handle);
			expect(registry.peek(retry.sessionId)?.state).toBe("open");
		} finally {
			await gate?.close();
			await Promise.all(
				registry.list().map(async ({ sessionId }) => {
					const worker = registry.peek(sessionId)?.worker;
					worker?.quarantine();
					await worker?.exited;
				}),
			);
			vi.unstubAllEnvs();
			await rm(scratch, { recursive: true, force: true });
		}
	},
	60_000,
);
