/**
 * Standalone worker for cross-process goal-store atomicity tests.
 *
 * Usage: bun <this-file> <baseDir> <threadId> <iterations>
 *
 * Each iteration calls accountGoalUsage with {input:1, output:0}, so the
 * expected final tokensUsed after N workers × M iterations = N × M.
 * One stdout line after the first committed update lets a test order its
 * own mutation after this process has started writing, without sleeping.
 */
import { accountGoalUsage } from "../../src/core/extensions/builtin/goal/store.ts";
import type { GoalStoreRef, TokenUsageSnapshot } from "../../src/core/extensions/builtin/goal/types.ts";

const ONE_INPUT_TOKEN: TokenUsageSnapshot = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1 };

const [baseDir, threadId, iterationsStr] = process.argv.slice(2);
if (!baseDir || !threadId || !iterationsStr) {
	process.stderr.write("usage: bun goal-cross-process-worker.ts <baseDir> <threadId> <iterations>\n");
	process.exit(2);
}

const iterations = Number(iterationsStr);
const ref: GoalStoreRef = { baseDir, threadId };

try {
	for (let i = 0; i < iterations; i++) {
		await accountGoalUsage(ref, ONE_INPUT_TOKEN, 0, "active");
		if (i === 0) process.stdout.write("first-update-committed\n");
	}
} catch (error) {
	const name = error instanceof Error ? error.name : "Error";
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`${name}: ${message}\n`);
	process.exit(1);
}
