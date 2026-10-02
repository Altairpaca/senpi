import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { attachJsonlLineReader, serializeJsonLine } from "../../src/modes/rpc/jsonl.ts";
import { RpcClient, type RpcClientEvent, RpcTransportGoneError } from "../../src/modes/rpc/rpc-client.ts";

async function createHost(autoOpenSessions = false) {
	const directory = await mkdtemp(join(tmpdir(), "rpc-compaction-deadline-"));
	const socketPath = join(directory, "rpc.sock");
	const connected = Promise.withResolvers<Socket>();
	const request = Promise.withResolvers<{ id: string; type: string; sessionId: string | undefined }>();
	let sessionNumber = 0;
	const server = createServer((socket) => {
		connected.resolve(socket);
		attachJsonlLineReader(socket, (line) => {
			const command: unknown = JSON.parse(line);
			if (
				typeof command !== "object" ||
				command === null ||
				!("id" in command) ||
				typeof command.id !== "string" ||
				!("type" in command) ||
				typeof command.type !== "string"
			) {
				throw new Error("Invalid client request");
			}
			if (autoOpenSessions && command.type === "open_session") {
				socket.write(
					serializeJsonLine({
						type: "response",
						id: command.id,
						command: "open_session",
						success: true,
						data: { sessionId: `session-${++sessionNumber}`, state: {} },
					}),
				);
				return;
			}
			const sessionId =
				"sessionId" in command && typeof command.sessionId === "string" ? command.sessionId : undefined;
			request.resolve({ id: command.id, type: command.type, sessionId });
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	const client = new RpcClient({ socketPath });
	await client.start();
	const peer = await connected.promise;
	return {
		client,
		peer,
		request: request.promise,
		async emit(event: RpcClientEvent & { sessionId?: string }) {
			const seen = Promise.withResolvers<void>();
			const unsubscribe = client.onEvent((received) => {
				if (received.type === event.type) {
					unsubscribe();
					seen.resolve();
				}
			});
			peer.write(serializeJsonLine(event));
			await seen.promise;
		},
		async close() {
			await client.stop();
			peer.destroy();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			await rm(directory, { recursive: true, force: true });
		},
	};
}

describe("RpcClient prompt admission during compaction", () => {
	afterEach(() => vi.useRealTimers());

	test.each([
		{ timing: "before", requestId: "current-compaction" },
		{ timing: "during", requestId: "current-compaction" },
		{ timing: "during", requestId: undefined },
	])(
		"keeps the real acknowledgement authoritative when compaction starts $timing admission ($requestId)",
		async ({ timing, requestId }) => {
			// Given: a real socket client, with time controlled independently of the host.
			const host = await createHost();
			const preflight = vi.fn();
			const disposition = vi.fn();
			try {
				vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
				if (timing === "before") {
					await host.emit({ type: "compaction_start", reason: "threshold", requestId });
				}
				const prompt = host.client
					.prompt("request", { preflightResult: preflight, promptDisposition: disposition })
					.catch((error: unknown) => error);
				const { id } = await host.request;

				// When: preflight compaction takes longer than the ordinary 30-second wait.
				if (timing === "during") {
					await host.emit({ type: "compaction_start", reason: "threshold", requestId });
				}
				await vi.advanceTimersByTimeAsync(60_000);
				expect(preflight).not.toHaveBeenCalled();
				await host.emit({
					type: "compaction_end",
					reason: "threshold",
					requestId,
					result: undefined,
					aborted: false,
					willRetry: false,
				});
				host.peer.write(
					serializeJsonLine({
						type: "response",
						command: "prompt",
						id,
						success: true,
						data: { disposition: "queued" },
					}),
				);

				// Then: only the host's actual response admits the prompt, with its original disposition.
				expect(await prompt).toBe("queued");
				expect(preflight.mock.calls).toEqual([[true]]);
				expect(disposition.mock.calls).toEqual([["queued"]]);
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				await host.close();
			}
		},
	);

	test("does not shorten an admission wait for another compaction's terminal event", async () => {
		// Given
		const host = await createHost();
		try {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const prompt = host.client.prompt("request").catch((error: unknown) => error);
			const { id } = await host.request;
			await host.emit({ type: "compaction_start", reason: "threshold", requestId: "current" });

			// When
			await host.emit({
				type: "compaction_end",
				reason: "threshold",
				requestId: "stale",
				result: undefined,
				aborted: false,
				willRetry: false,
			});
			await vi.advanceTimersByTimeAsync(60_000);
			host.peer.write(
				serializeJsonLine({
					type: "response",
					command: "prompt",
					id,
					success: true,
					data: { disposition: "queued" },
				}),
			);

			// Then
			expect(await prompt).toBe("queued");
		} finally {
			await host.close();
		}
	});

	test.each(["no compaction", "completed compaction", "non-prompt request"])(
		"retains the ordinary admission deadline for %s",
		async (scenario) => {
			// Given
			const host = await createHost();
			try {
				vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
				let settled = false;
				const operation = (
					scenario === "non-prompt request" ? host.client.getState() : host.client.prompt("request")
				)
					.catch((error: unknown) => error)
					.finally(() => {
						settled = true;
					});
				await host.request;
				if (scenario !== "no compaction") {
					await host.emit({ type: "compaction_start", reason: "threshold", requestId: "current" });
				}
				if (scenario === "completed compaction") {
					await vi.advanceTimersByTimeAsync(60_000);
					expect(settled).toBe(false);
					await host.emit({
						type: "compaction_end",
						reason: "threshold",
						requestId: "current",
						result: undefined,
						aborted: false,
						willRetry: false,
					});
				}

				// When
				await vi.advanceTimersByTimeAsync(30_000);

				// Then
				expect(settled).toBe(true);
				expect(await operation).toBeInstanceOf(Error);
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				await host.close();
			}
		},
	);

	test("does not extend admission for a foreign session's compaction", async () => {
		// Given
		const host = await createHost();
		const preflight = vi.fn();
		try {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const prompt = host.client.prompt("request", { preflightResult: preflight }).catch((error: unknown) => error);
			await host.request;

			// When: a following frame fences the ignored foreign event's delivery.
			host.peer.write(
				serializeJsonLine({
					type: "compaction_start",
					reason: "threshold",
					requestId: "foreign",
					sessionId: "another-session",
				}),
			);
			await host.emit({ type: "bash_start" });
			await vi.advanceTimersByTimeAsync(30_000);

			// Then
			expect(preflight.mock.calls).toEqual([[false]]);
			expect(await prompt).toBeInstanceOf(Error);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			await host.close();
		}
	});

	test.each([true, false])("isolates prior lease deadlines (compacting=%s)", async (firstCompacts) => {
		// Given: one socket can retain several leases and their correlated requests.
		const host = await createHost(true);
		const preflight = vi.fn();
		try {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const first = await host.client.openSession({});
			if (firstCompacts) {
				await host.emit({
					type: "compaction_start",
					reason: "threshold",
					requestId: "first-operation",
					sessionId: first.sessionId,
				});
			}
			const prompt = host.client
				.prompt("first-session request", { preflightResult: preflight })
				.catch((error: unknown) => error);
			const { id, sessionId } = await host.request;
			expect(sessionId).toBe(first.sessionId);

			// When: only the new lease emits compaction events.
			const second = await host.client.openSession({});
			await host.emit({
				type: "compaction_start",
				reason: "threshold",
				requestId: "second-operation",
				sessionId: second.sessionId,
			});
			if (!firstCompacts) {
				await vi.advanceTimersByTimeAsync(30_000);

				// Then: an ordinary request keeps its original deadline.
				expect(preflight.mock.calls).toEqual([[false]]);
				expect(await prompt).toBeInstanceOf(Error);
				expect(vi.getTimerCount()).toBe(0);
				return;
			}
			await host.emit({
				type: "compaction_end",
				reason: "threshold",
				requestId: "second-operation",
				sessionId: second.sessionId,
				result: undefined,
				aborted: false,
				willRetry: false,
			});
			await vi.advanceTimersByTimeAsync(60_000);
			expect(preflight).not.toHaveBeenCalled();
			host.peer.write(
				serializeJsonLine({
					type: "response",
					command: "prompt",
					id,
					sessionId: first.sessionId,
					success: true,
					data: { disposition: "started" },
				}),
			);

			// Then: the original session's actual response still admits its outstanding prompt.
			expect(await prompt).toBe("started");
			expect(preflight.mock.calls).toEqual([[true]]);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			await host.close();
		}
	});

	test("bounds a compaction even if its start event is repeated", async () => {
		// Given
		const host = await createHost();
		try {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const prompt = host.client.prompt("request").catch((error: unknown) => error);
			await host.request;
			await host.emit({ type: "compaction_start", reason: "threshold", requestId: "current" });

			// When
			await vi.advanceTimersByTimeAsync(30 * 60_000);
			await host.emit({ type: "compaction_start", reason: "threshold", requestId: "current" });
			await vi.advanceTimersByTimeAsync(15 * 60_000 + 30_000 - 1);
			let settled = false;
			void prompt.then(() => {
				settled = true;
			});
			await Promise.resolve();
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1);

			// Then
			expect(settled).toBe(true);
			expect(await prompt).toBeInstanceOf(Error);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			await host.close();
		}
	});

	test("rejects at once and clears the extended deadline when the transport disconnects", async () => {
		// Given
		const host = await createHost();
		try {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const prompt = host.client.prompt("request").catch((error: unknown) => error);
			await host.request;
			await host.emit({ type: "compaction_start", reason: "threshold", requestId: "current" });

			// When
			host.peer.destroy();

			// Then
			expect(await prompt).toBeInstanceOf(RpcTransportGoneError);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			await host.close();
		}
	});
});
