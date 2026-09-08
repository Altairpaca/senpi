import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, type open, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { SESSION_WORKER_LIMITS } from "../../src/modes/rpc/session-worker-protocol.ts";
import { WorkerSessionRegistry } from "../../src/modes/rpc/worker-session-registry.ts";
import { waitForFifoReader } from "./rpc-worker-host-support.ts";

const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;

async function phase<T>(name: string, signal: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	process.stderr.write(`RESERVATION_AWAIT ${name}\n`);
	try {
		const result = await Promise.race([
			signal,
			new Promise<never>((_resolve, reject) => {
				timer = realSetTimeout(() => reject(new Error(`Reservation phase timed out: ${name}`)), 10_000);
			}),
		]);
		process.stderr.write(`RESERVATION_DONE ${name}\n`);
		return result;
	} finally {
		realClearTimeout(timer);
	}
}

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
			// Advance the real request scheduler only after the native FIFO entry signal.
			// Worker threads and filesystem operations remain real; the test keeps its 60s ceiling.
			if (action === "deadline") vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
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
			if (action === "close") await phase("close", registry.close(handle));
			else {
				await vi.advanceTimersByTimeAsync(SESSION_WORKER_LIMITS.openMs);
				vi.useRealTimers();
				expect(await phase("opening-deadline", opening)).toBe("cancelled");
			}
			expect(exited).toBe(false);
			expect(registry.peek(handle)?.state).toBe("quarantined");
			const published = registry.list();
			expect(published.find((entry) => entry.sessionId === handle)?.status).toBe("closing");
			// Match the desktop eagerReattach predicate, not an expanded private state enum.
			expect(published.some((entry) => entry.sessionPath === canonicalFifo && entry.status !== "closing")).toBe(
				false,
			);
			expect(registry.size).toBeGreaterThan(0);
			await expect(phase("alias-denial", registry.openSession({ cwd, sessionPath: alias }))).rejects.toThrow(
				"session_path_in_use",
			);
			const header = `${JSON.stringify({ type: "session", version: 3, id: "retry-durable", timestamp: new Date(0).toISOString(), cwd })}\n`;
			await unlink(fifo);
			await writeFile(fifo, header);
			await phase("gate-write", gate.write(header));
			await phase("gate-close", gate.close());
			gate = undefined;
			await phase("worker-exit", exit);
			expect(await phase("opening-cancelled", opening)).toBe("cancelled");
			const retry = await phase("same-path-retry", registry.openSession({ cwd, sessionPath: alias }));
			expect(retry.durableSessionId).toBe("retry-durable");
			expect(retry.sessionId).not.toBe(handle);
			expect(registry.peek(retry.sessionId)?.state).toBe("open");
		} finally {
			vi.useRealTimers();
			try {
				await phase("cleanup-gate", gate?.close() ?? Promise.resolve());
				await phase(
					"cleanup-workers",
					Promise.all(
						registry.list().map(({ sessionId }) => {
							const worker = registry.peek(sessionId)?.worker;
							const exited = worker?.exited;
							worker?.quarantine();
							return exited;
						}),
					),
				);
			} finally {
				vi.unstubAllEnvs();
				await rm(scratch, { recursive: true, force: true });
			}
		}
	},
	60_000,
);
