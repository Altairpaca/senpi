import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it } from "vitest";
import { goalLockFilePath } from "../../src/core/extensions/builtin/goal/goal-file-lock.ts";
import { writeGoalFile } from "../../src/core/extensions/builtin/goal/persistence.ts";
import {
	accountGoalUsage,
	createGoal,
	goalFilePath,
	readGoal,
	updateGoal,
} from "../../src/core/extensions/builtin/goal/store.ts";
import type { GoalStoreRef, TokenUsageSnapshot } from "../../src/core/extensions/builtin/goal/types.ts";
import { FILE_STORAGE_LOCK_OPTIONS } from "../../src/core/lockfile-policy.ts";

const tempDirs: string[] = [];
const workerPath = join(import.meta.dirname, "goal-cross-process-worker.ts");
const packageRoot = join(import.meta.dirname, "../..");
const ONE_INPUT_TOKEN: TokenUsageSnapshot = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1 };

interface WorkerRun {
	firstUpdateCommitted: Promise<void>;
	exited: Promise<{ exitCode: number; stderr: string }>;
}

async function tempStore(threadId: string): Promise<{ ref: GoalStoreRef; agentDir: string }> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-goal-xproc-"));
	tempDirs.push(dir);
	return { ref: { baseDir: join(dir, "extensions", "goal"), threadId }, agentDir: join(dir, "agent") };
}

function spawnWorker(ref: GoalStoreRef, agentDir: string, iterations: number): WorkerRun {
	const child = spawn("bun", [workerPath, ref.baseDir, ref.threadId, String(iterations)], {
		cwd: packageRoot,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, SENPI_CODING_AGENT_DIR: agentDir },
	});
	const firstUpdateCommitted = new Promise<void>((resolve, reject) => {
		child.stdout.on("data", () => resolve());
		child.on("close", () => reject(new Error("worker exited before committing an update")));
	});
	firstUpdateCommitted.catch(() => undefined);
	const stderrChunks: Buffer[] = [];
	child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
	const exited = new Promise<{ exitCode: number; stderr: string }>((resolve) => {
		child.on("close", (code) => {
			resolve({ exitCode: code ?? 1, stderr: Buffer.concat(stderrChunks).toString("utf8") });
		});
	});
	return { firstUpdateCommitted, exited };
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("goal store cross-process atomicity", () => {
	it("keeps 600 of 600 usage updates from two real processes", async () => {
		// Given: one active goal shared by two separate processes.
		const { ref, agentDir } = await tempStore("two-process-race");
		await createGoal(ref, "Cross-process atomicity probe");

		// When: each process runs 300 read-modify-write usage updates concurrently.
		const [a, b] = await Promise.all([
			spawnWorker(ref, agentDir, 300).exited,
			spawnWorker(ref, agentDir, 300).exited,
		]);

		// Then: no update is lost and the status is untouched.
		expect(a).toEqual({ exitCode: 0, stderr: "" });
		expect(b).toEqual({ exitCode: 0, stderr: "" });
		const goal = await readGoal(ref);
		expect(goal?.tokensUsed).toBe(600);
		expect(goal?.status).toBe("active");
	}, 120_000);

	it("never reverts a completion applied while another process is still accounting usage", async () => {
		// Given: a second process already committing usage updates to the active goal.
		const { ref, agentDir } = await tempStore("status-revert-race");
		await createGoal(ref, "Status revert probe");
		const worker = spawnWorker(ref, agentDir, 2_000);
		await worker.firstUpdateCommitted;

		// When: this process completes the goal mid-stream.
		const completed = await updateGoal(ref, { status: "complete" }, "model");
		const result = await worker.exited;

		// Then: the completion is the last transition and no stale writer brought the goal back.
		expect(result.exitCode).toBe(0);
		const goal = await readGoal(ref);
		expect(goal?.status).toBe("complete");
		expect(goal?.tokensUsed).toBe(completed.tokensUsed);
	}, 120_000);

	it("rejects a writer visibly instead of overwriting the newer goal held under the lock", async () => {
		// Given: this process holds the goal lock and has written a newer value under it.
		const { ref, agentDir } = await tempStore("lock-busy-rejection");
		const seeded = await createGoal(ref, "Lock busy rejection probe");
		const release = await lockfile.lock(goalFilePath(ref), {
			...FILE_STORAGE_LOCK_OPTIONS,
			lockfilePath: goalLockFilePath(ref),
		});
		let result: { exitCode: number; stderr: string };
		try {
			await writeGoalFile(ref, { ...seeded, tokensUsed: 42 });

			// When: another process tries to update the same goal past the lock wait budget.
			result = await spawnWorker(ref, agentDir, 1).exited;
		} finally {
			await release();
		}

		// Then: the other writer fails loudly with the busy reason and the newer value survives.
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("GoalStoreBusyError: Goal store is busy");
		expect((await readGoal(ref))?.tokensUsed).toBe(42);
	}, 30_000);

	it("lands all updates from two concurrent loops in one process", async () => {
		// Given: one goal and a single process.
		const { ref } = await tempStore("single-process-fast-path");
		await createGoal(ref, "Single-process concurrency probe");

		// When: two concurrent loops each account 300 usage updates.
		const loop = async () => {
			for (let i = 0; i < 300; i++) await accountGoalUsage(ref, ONE_INPUT_TOKEN, 0, "active");
		};
		await Promise.all([loop(), loop()]);

		// Then: the in-process tail keeps every update.
		expect((await readGoal(ref))?.tokensUsed).toBe(600);
	}, 60_000);
});
