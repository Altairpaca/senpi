import { afterEach, expect, it, vi } from "vitest";
import type { ResultMessage } from "../../src/kernels/js/kernel-contract.ts";
import { driveInlineTimeout, INLINE_PROBE_BOUNDS } from "../eval/inline-timeout-probe.ts";

afterEach(() => vi.useRealTimers());

it("surfaces a failed run before the startup marker arrives", async () => {
	// Given: the worker settles with a useful error without printing its marker.
	vi.useFakeTimers();
	const started = Promise.withResolvers<void>();
	const result: ResultMessage = {
		type: "result",
		cellId: "probe",
		ok: false,
		error: { message: "worker startup failed" },
		durationMs: 0,
	};
	let outcome: unknown;
	// When
	const driven = driveInlineTimeout(started.promise, Promise.resolve(result), async (milliseconds) => {
		await vi.advanceTimersByTimeAsync(milliseconds);
	});
	const observed = driven.then(
		(value) => {
			outcome = value;
		},
		(error: unknown) => {
			outcome = error;
		},
	);
	await vi.advanceTimersByTimeAsync(0);
	// Then: startup failure is surfaced, not hidden behind a pending marker.
	expect(outcome).toEqual(new Error("worker startup failed"));
	started.resolve();
	await observed;
});

it("advances the termination deadline when retirement never settles", async () => {
	// Given: a host retirement deadline which is scheduled after timeout and acknowledgement.
	vi.useFakeTimers();
	const running = Promise.withResolvers<ResultMessage>();
	const result: ResultMessage = {
		type: "result",
		cellId: "probe",
		ok: false,
		error: { message: "timed out" },
		durationMs: 150,
	};
	setTimeout(() => {
		setTimeout(() => {
			setTimeout(() => running.resolve(result), INLINE_PROBE_BOUNDS.terminateDeadlineMs);
		}, INLINE_PROBE_BOUNDS.ackMs);
	}, 150);
	let outcome: unknown;
	// When
	const observed = driveInlineTimeout(Promise.resolve(), running.promise, async (milliseconds) => {
		vi.advanceTimersByTime(milliseconds);
	}).then((value) => {
		outcome = value;
	});
	await vi.advanceTimersByTimeAsync(0);
	// Then: the driver's own clock releases retirement, without a wall-clock watchdog.
	expect(outcome).toEqual(result);
	running.resolve(result);
	await observed;
});
