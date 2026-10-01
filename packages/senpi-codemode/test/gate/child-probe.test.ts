import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { collectChild } from "../eval/child-probe.ts";

afterEach(() => vi.useRealTimers());

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
		const ready = once(child, "message");
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
