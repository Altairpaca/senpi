import { ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { collectChild, waitForChildReady } from "../eval/child-probe.ts";

afterEach(() => vi.useRealTimers());

it("does not preempt the QA driver's declared 240-second budget", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const child = new ChildProcess();
	vi.spyOn(child, "kill").mockReturnValue(false);
	let settled = false;
	const outcome = collectChild(child).then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	try {
		await vi.advanceTimersByTimeAsync(180_000);
		expect(settled).toBe(false);
	} finally {
		await vi.advanceTimersByTimeAsync(240_000);
		await outcome;
	}
});

it("retains buffered stdout and stderr when its hang watchdog fires", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const child = new ChildProcess();
	vi.spyOn(child, "kill").mockReturnValue(false);
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	child.stdout = stdout;
	child.stderr = stderr;
	const outcome = collectChild(child).catch((error: unknown) => error);
	stdout.write("buffered-output");
	stderr.write("buffered-error");
	await vi.advanceTimersByTimeAsync(240_000);
	const error: unknown = await outcome;
	if (!(error instanceof Error)) throw new TypeError("Watchdog did not reject");
	expect(error.message).toContain("buffered-output");
	expect(error.message).toContain("buffered-error");
});

it("rejects with the spawn failure instead of throwing before error subscription", async () => {
	// Given: a missing executable and an independent observer of the OS failure.
	const child = spawn("senpi-deliberately-missing-probe-command", [], { stdio: ["ignore", "pipe", "pipe"] });
	const failed = once(child, "error");
	// When / Then: the collector returns a rejected promise carrying ENOENT.
	await expect(Promise.resolve().then(() => collectChild(child))).rejects.toMatchObject({ code: "ENOENT" });
	await failed;
});

it("rejects readiness immediately when the child exits before its marker", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const child = spawn(process.execPath, ["-e", "process.exit(1)"], {
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	let error: unknown;
	const readiness = waitForChildReady(child).catch((failure: unknown) => {
		error = failure;
	});
	try {
		await collectChild(child);
		await vi.advanceTimersByTimeAsync(0);
		expect(error).toBeInstanceOf(TypeError);
		await readiness;
	} finally {
		child.removeAllListeners();
	}
});

it.each([1, 2, 3])(
	"waits for a deliberately held child rather than its startup deadline (%s)",
	async () => {
		// Given: an actual child held at an IPC barrier before producing its output.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const child = spawn(
			process.execPath,
			[
				"-e",
				'process.send("ready"); process.once("message", () => { console.log("released"); process.disconnect(); });',
			],
			{ stdio: ["ignore", "pipe", "pipe", "ipc"] },
		);
		const ready = waitForChildReady(child);
		const result = collectChild(child);
		const outcome = result.then(
			(value) => ({ kind: "closed", value }),
			(error: unknown) => ({ kind: "error", error }),
		);
		try {
			await ready;
			// When: startup lasts beyond every old driver deadline without consuming real time.
			await vi.advanceTimersByTimeAsync(61_000);
			child.send("release");
			// Then: the close event still returns complete output, not a SIGKILL.
			await expect(outcome).resolves.toMatchObject({
				kind: "closed",
				value: { code: 0, signal: null, stdout: "released\n" },
			});
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}
	},
	180_000,
);
