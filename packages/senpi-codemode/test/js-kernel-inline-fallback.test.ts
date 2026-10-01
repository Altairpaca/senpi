import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { runChild } from "./eval/child-probe.ts";

describe("JavaScriptKernel isolated inline fallback", () => {
	it("times out a synchronous infinite loop and leaves no live child process", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-js-inline-fallback-"));
		try {
			const scriptPath = join(root, "fallback-runner.mjs");
			const kernelUrl = pathToFileURL(join(process.cwd(), "src", "kernels", "js", "context-manager.ts")).href;
			const missingWorkerUrl = pathToFileURL(join(root, "missing-worker-entry.js")).href;
			await writeFile(
				scriptPath,
				`import { JavaScriptKernel } from ${JSON.stringify(kernelUrl)};
import { mock } from "node:test";

let loopStarted;
const started = new Promise((resolve) => { loopStarted = resolve; });
const kernel = new JavaScriptKernel({
  sessionId: "isolated-inline-fallback",
  cwd: process.cwd(),
  parallelPoolWidth: 2,
  workerEntryUrl: new URL(${JSON.stringify(missingWorkerUrl)}),
  onMessage: (message) => { if (message.type === "text" && message.data.includes("loop-started")) loopStarted(); },
  interruptBounds: { ackMs: 500, graceMs: 2000, terminateDeadlineMs: 180000 },
});
const baselineWorkerIds = process.report.getReport().workers.map((worker) => worker.header.threadId);
try {
  await kernel.run({ cellId: "warm", code: "1 + 1" });
  mock.timers.enable({ apis: ["setTimeout"] });
  const running = kernel.run({ cellId: "infinite-loop", code: 'print("loop-started"); return (() => { while (true) {} })()', timeoutMs: 150 });
  await started;
  mock.timers.tick(150);
  await new Promise((resolve) => setImmediate(resolve));
  mock.timers.tick(500);
  const result = await running;
  mock.timers.reset();
  await kernel.close();
  await new Promise((resolve) => setImmediate(resolve));
  const liveWorkerIds = process.report.getReport().workers
    .map((worker) => worker.header.threadId)
    .filter((threadId) => !baselineWorkerIds.includes(threadId));
  process.stdout.write(JSON.stringify({ mode: kernel.mode, result, liveWorkerIds }));
} finally {
  mock.timers.reset();
  await kernel.close();
}
`,
			);

			const childRun = await runChild({
				command: process.execPath,
				args: ["--import", "tsx", scriptPath],
				cwd: process.cwd(),
			});
			expect(childRun.signal, JSON.stringify(childRun)).toBeNull();
			expect(childRun.code).toBe(0);
			expect(childRun.stderr).toBe("");
			const output: unknown = JSON.parse(childRun.stdout);
			expect(output).toMatchObject({
				mode: "inline",
				result: { ok: false, error: { message: expect.stringMatching(/timed out/i) } },
				liveWorkerIds: [],
			});
			expect(isProcessAlive(childRun.pid)).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 240_000);
});

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
		throw error;
	}
}
