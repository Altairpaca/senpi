import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, open, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SessionCommandRouter } from "../../src/modes/rpc/session-command-router.ts";
import {
	MAX_SHARED_STDIO_QUEUE_BYTES,
	MAX_SHARED_STDIO_QUEUE_RECORDS,
	SessionEventWriter,
} from "../../src/modes/rpc/session-event-writer.ts";
import { waitForFifoReader } from "./rpc-worker-host-support.ts";
import { reservationPhase as phase, reservationHost } from "./rpc-worker-reservation-support.ts";

const overflow = { type: "overflow", command: "close_session", error: "rpc_close_output_overflow, resync required" };
const response = (id: string) => ({ type: "response", command: "close_session", id, success: true });

// PR1499: independent held-scheduler RED, extended to bytes and observable recovery.
it.each(["records", "bytes"])("bounds duplicate close %s without dropping admitted terminal records", async (limit) => {
	const records: Array<Record<string, unknown>> = [];
	const writer = new SessionEventWriter(
		(line) => records.push(JSON.parse(line)),
		(_flush) => {},
	);
	const count = limit === "records" ? MAX_SHARED_STDIO_QUEUE_RECORDS + 100 : 70;
	const id = limit === "records" ? "" : "x".repeat(1024 * 1024);
	writer.closeSession("rpc-1", response("first"));
	try {
		for (let i = 0; i < count; i++) writer.enqueueClosedResponse("rpc-1", response(`${i}:${id}`));
		expect(writer.bufferedRecordCount).toBeLessThanOrEqual(MAX_SHARED_STDIO_QUEUE_RECORDS + 1);
		expect(writer.bufferedByteLength).toBeLessThanOrEqual(
			MAX_SHARED_STDIO_QUEUE_BYTES + JSON.stringify(overflow).length + 1,
		);
		await writer.flush();
		expect(records.filter((record) => record.type === "overflow")).toEqual([overflow]);
		const replies = records.filter((record) => record.sessionId === "rpc-1");
		expect(replies.slice(0, 2)).toEqual([
			{ type: "session_closed", sessionId: "rpc-1" },
			{ ...response("first"), sessionId: "rpc-1" },
		]);
		expect(replies.slice(2).map((record) => record.id)).toEqual(
			Array.from({ length: replies.length - 2 }, (_, i) => `${i}:${id}`),
		);
		expect(replies.length - 2).toBeLessThan(count);
		writer.enqueueClosedResponse("rpc-1", response("after-drain"));
		await writer.flush();
		expect(records.at(-1)).toEqual({ ...response("after-drain"), sessionId: "rpc-1" });
	} finally {
		await writer.flush();
	}
});

it.each(["quarantined", "finalizing-records", "finalizing-bytes"])(
	"bounds real FIFO worker close debt while %s and retains ownership until native exit",
	async (state) => {
		const scratch = await mkdtemp(join(tmpdir(), "senpi-close-bound-"));
		const cwd = join(scratch, "cwd"),
			agentDir = join(scratch, "agent"),
			fifo = join(scratch, "blocked.jsonl");
		await mkdir(cwd);
		await mkdir(agentDir);
		execFileSync("mkfifo", [fifo]);
		vi.stubEnv("PATH", "/usr/bin:/bin");
		vi.stubEnv("SENPI_OFFLINE", "1");
		const host = reservationHost(cwd, agentDir);
		host.connect("opening");
		const records: Array<Record<string, unknown>> = [];
		const writer = new SessionEventWriter(
			(line) => records.push(JSON.parse(line)),
			(_flush) => {},
		);
		const router = new SessionCommandRouter(host.registry, writer, { cwd });
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const closeMarked = host.registry.closeMarked.bind(host.registry);
		const finalizing = state !== "quarantined";
		const teardown = vi.spyOn(host.registry, "closeMarked").mockImplementation(async (handle) => {
			entered.resolve();
			if (finalizing) await gate.promise;
			await closeMarked(handle);
		});
		let reader: Awaited<ReturnType<typeof open>> | undefined;
		const pending: Array<Promise<unknown>> = [];
		try {
			const opening = host.send("opening", { type: "open_session", cwd, sessionPath: fifo });
			pending.push(opening);
			reader = await waitForFifoReader(fifo);
			const entry = host.registry.list()[0];
			const worker = host.registry.peek(entry.sessionId)?.worker;
			if (!worker) throw new Error("Missing native worker");
			if (finalizing) {
				pending.push(router.handle({ type: "close_session", sessionId: entry.sessionId, id: "first" }));
				await phase("finalizer-entered", entered.promise);
			} else {
				await phase("cancel", host.registry.close(entry.sessionId));
				expect(await phase("opening-cancelled", opening)).toMatchObject({ success: false });
			}
			const attachments = host.registry.peek(entry.sessionId)?.attachments;
			const count = state === "finalizing-bytes" ? 70 : MAX_SHARED_STDIO_QUEUE_RECORDS + 100;
			const suffix = state === "finalizing-bytes" ? "x".repeat(1024 * 1024) : "";
			for (let i = 0; i < count; i++)
				pending.push(router.handle({ type: "close_session", sessionId: entry.sessionId, id: `${i}:${suffix}` }));
			// All calls have reached admission synchronously. No finalizer gate or
			// output scheduler has been released, so waiting replies must count now.
			const debt = writer.pendingCloseRecordCount;
			expect(writer.bufferedRecordCount + debt).toBeLessThanOrEqual(MAX_SHARED_STDIO_QUEUE_RECORDS + 1);
			expect(writer.bufferedByteLength + writer.pendingCloseByteLength).toBeLessThanOrEqual(
				MAX_SHARED_STDIO_QUEUE_BYTES + JSON.stringify(overflow).length + 1,
			);
			expect(debt).toBeLessThan(count * 2);
			expect(host.exited.has(worker)).toBe(false);
			expect(host.registry.peek(entry.sessionId)?.attachments).toBe(attachments);
			expect(await host.send("opening", { type: "open_session", cwd, sessionPath: fifo })).toMatchObject({
				success: false,
				error: expect.stringContaining("session_path_in_use"),
			});
			gate.resolve();
			await phase("close-replies-settled", Promise.all(pending));
			expect(writer.pendingCloseRecordCount).toBe(0);
			expect(writer.pendingCloseByteLength).toBe(0);
			expect(host.exited.has(worker)).toBe(false);
			expect(host.registry.peek(entry.sessionId)?.state).toBe("quarantined");
			await writer.flush();
			expect(records.filter((record) => record.type === "overflow")).toEqual([overflow]);
			const replies = records.filter((record) => record.sessionId === entry.sessionId);
			if (finalizing)
				expect(replies.splice(0, 2)).toEqual([
					{ type: "session_closed", sessionId: entry.sessionId },
					expect.objectContaining({ id: "first", success: true }),
				]);
			expect(replies.length).toBeGreaterThan(0);
			expect(replies.length).toBeLessThan(count);
			expect(replies.map((record) => record.id)).toEqual(
				Array.from({ length: replies.length }, (_, i) => `${i}:${suffix}`),
			);
			console.log("CLOSE_ADMISSION_PROOF", {
				state,
				debt,
				replies: replies.length,
				workerExited: host.exited.has(worker),
				registrySize: host.registry.size,
			});
		} finally {
			gate.resolve();
			const rescue = await open(fifo, "r+");
			try {
				await unlink(fifo);
				const header = `${JSON.stringify({ type: "session", version: 3, id: "bound-durable", timestamp: new Date(0).toISOString(), cwd })}\n`;
				await writeFile(fifo, header);
				await rescue.write(header);
			} finally {
				await Promise.all([reader?.close(), rescue.close()]);
			}
			await host.dispose();
			await Promise.all(pending);
			await router.dispose();
			await writer.flush();
			teardown.mockRestore();
			vi.unstubAllEnvs();
			await rm(scratch, { recursive: true, force: true });
		}
	},
	60_000,
);
