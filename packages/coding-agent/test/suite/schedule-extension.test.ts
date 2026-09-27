import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import {
	createScheduledJob,
	listScheduledJobs,
	scheduleDir,
} from "../../src/core/extensions/builtin/schedule/store.ts";
import { SCHEDULE_PROMPT_TOOL, type SchedulePromptDetails } from "../../src/core/extensions/builtin/schedule/tool.ts";
import { discoverAndLoadExtensions } from "../../src/core/extensions/loader.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

const SCHEDULE_EXTENSION_PATH = fileURLToPath(
	new URL("../../src/core/extensions/builtin/schedule/index.ts", import.meta.url),
);
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

/** The harness session's agent directory, which the tool resolves through `ctx.agentDir`. */
function jobsDir(harness: Harness): string {
	return scheduleDir(join(harness.tempDir, "agent"));
}

async function scheduleHarness(): Promise<Harness> {
	const extensionsResult = await discoverAndLoadExtensions([SCHEDULE_EXTENSION_PATH], REPO_ROOT, REPO_ROOT);
	const harness = await createHarness({ resourceLoader: createTestResourceLoader({ extensionsResult }) });
	harnesses.push(harness);
	return harness;
}

async function callSchedule(harness: Harness, params: Record<string, unknown>) {
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall(SCHEDULE_PROMPT_TOOL, params)], { stopReason: "toolUse" }),
		fauxAssistantMessage("ok"),
	]);
	await harness.session.prompt("go");
	const results = harness.session.messages.filter(
		(message) => message.role === "toolResult" && message.toolName === SCHEDULE_PROMPT_TOOL,
	);
	const result = results[results.length - 1];
	if (result?.role !== "toolResult") throw new Error("expected a schedule_prompt result");
	return result;
}

function resultText(result: Awaited<ReturnType<typeof callSchedule>>): string {
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

describe("schedule extension", () => {
	it("is registered as a builtin so every run mode, including --print, can schedule", () => {
		expect(builtinExtensions.map((extension) => extension.id)).toContain("schedule");
	});

	it("persists a job for the calling session that outlives the tool call", async () => {
		const harness = await scheduleHarness();
		const before = Date.now();

		const result = await callSchedule(harness, {
			action: "create",
			prompt: "tell Howard the build finished",
			delaySeconds: 300,
		});

		expect(result.isError).toBe(false);
		const details = result.details as SchedulePromptDetails;
		const { jobs } = await listScheduledJobs(jobsDir(harness));
		expect(jobs).toEqual(details.jobs);
		expect(jobs).toHaveLength(1);
		const job = jobs[0]?.job;
		expect(job).toMatchObject({
			sessionId: harness.sessionManager.getSessionId(),
			prompt: "tell Howard the build finished",
			everyMs: null,
		});
		expect(job?.dueAt).toBeGreaterThanOrEqual(before + 300_000);
		expect(resultText(result)).toContain(`Scheduled ${job?.id} [pending]`);
		expect(resultText(result)).toContain("No `senpi schedule run --watch` runner is active");
	});

	it("lists and cancels only this session's jobs", async () => {
		const harness = await scheduleHarness();
		const dir = jobsDir(harness);
		const foreign = await createScheduledJob(
			dir,
			{
				sessionId: "other-session",
				sessionFile: null,
				cwd: "/",
				prompt: "not yours",
				dueAt: Date.now() + 60_000,
				everyMs: null,
			},
			Date.now(),
		);
		const created = await callSchedule(harness, {
			action: "create",
			prompt: "mine",
			at: new Date(Date.now() + 3_600_000).toISOString(),
			everySeconds: 86_400,
		});
		const ownId = (created.details as SchedulePromptDetails).jobs[0]?.job.id;

		const listed = await callSchedule(harness, { action: "list" });
		expect((listed.details as SchedulePromptDetails).jobs.map(({ job }) => job.id)).toEqual([ownId]);

		const refused = await callSchedule(harness, { action: "cancel", id: foreign.id });
		expect(refused.isError).toBe(true);
		const cancelled = await callSchedule(harness, { action: "cancel", id: ownId });
		expect(cancelled.isError).toBe(false);
		expect((await listScheduledJobs(dir)).jobs.map(({ job }) => job.id)).toEqual([foreign.id]);
	});

	it("rejects ambiguous or past due times without writing a job", async () => {
		const harness = await scheduleHarness();

		const both = await callSchedule(harness, {
			action: "create",
			prompt: "x",
			delaySeconds: 60,
			at: "2030-01-01T00:00:00Z",
		});
		const past = await callSchedule(harness, { action: "create", prompt: "x", at: "2020-01-01T00:00:00Z" });
		const tooFrequent = await callSchedule(harness, {
			action: "create",
			prompt: "x",
			delaySeconds: 60,
			everySeconds: 5,
		});

		expect([both.isError, past.isError, tooFrequent.isError]).toEqual([true, true, true]);
		expect(resultText(both)).toContain("exactly one of delaySeconds or at");
		expect(resultText(past)).toContain("is in the past");
		expect((await listScheduledJobs(jobsDir(harness))).jobs).toEqual([]);
	});
});
