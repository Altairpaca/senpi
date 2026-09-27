import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type Delivery,
	runDueJobs,
	type ScheduledPromptEvent,
} from "../../src/core/extensions/builtin/schedule/runner.ts";
import {
	cancelScheduledJob,
	createScheduledJob,
	listScheduledJobs,
	type NewScheduledJob,
} from "../../src/core/extensions/builtin/schedule/store.ts";
import { nextRecurringDueAt } from "../../src/core/extensions/builtin/schedule/types.ts";

const T0 = Date.parse("2026-09-27T12:00:00Z");
const dirs: string[] = [];

async function tempScheduleDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-schedule-"));
	dirs.push(dir);
	return join(dir, "schedule");
}

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function jobInput(overrides: Partial<NewScheduledJob> = {}): NewScheduledJob {
	return {
		sessionId: "session-a",
		sessionFile: "/sessions/a.jsonl",
		cwd: "/work",
		prompt: "remind Howard to stretch",
		dueAt: T0 + 60_000,
		everyMs: null,
		...overrides,
	};
}

function recordingDelivery(result: Awaited<ReturnType<Delivery>> = { ok: true }) {
	const events: ScheduledPromptEvent[] = [];
	const deliver: Delivery = async (event) => {
		events.push(event);
		return result;
	};
	return { events, deliver };
}

describe("schedule runner", () => {
	it("fires a due one-shot job once, with its session and prompt, then forgets it", async () => {
		const dir = await tempScheduleDir();
		const job = await createScheduledJob(dir, jobInput(), T0);
		const { events, deliver } = recordingDelivery();

		const first = await runDueJobs({ dir, now: () => T0 + 61_000, deliver });
		const second = await runDueJobs({ dir, now: () => T0 + 62_000, deliver });

		expect(first.fired).toEqual([
			expect.objectContaining({ id: job.id, sessionId: "session-a", outcome: "delivered" }),
		]);
		expect(second.fired).toEqual([]);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: "scheduled_prompt",
			id: job.id,
			sessionId: "session-a",
			sessionFile: "/sessions/a.jsonl",
			cwd: "/work",
			prompt: "remind Howard to stretch",
			fireCount: 1,
			firedAt: T0 + 61_000,
		});
		expect(events[0]?.message.split("\n")[0]).toContain(`Scheduled prompt ${job.id}`);
		expect(events[0]?.message.endsWith("\nremind Howard to stretch")).toBe(true);
		expect((await listScheduledJobs(dir)).jobs).toEqual([]);
	});

	it("leaves a job that is not due yet untouched and reports when it is due", async () => {
		const dir = await tempScheduleDir();
		const job = await createScheduledJob(dir, jobInput({ dueAt: T0 + 300_000 }), T0);
		const { events, deliver } = recordingDelivery();

		const result = await runDueJobs({ dir, now: () => T0 + 299_999, deliver });

		expect(events).toEqual([]);
		expect(result.nextDueAt).toBe(T0 + 300_000);
		expect((await listScheduledJobs(dir)).jobs).toEqual([{ state: "pending", job }]);
	});

	it("keeps a failed one-shot job in failed/ with the delivery error", async () => {
		const dir = await tempScheduleDir();
		const job = await createScheduledJob(dir, jobInput(), T0);
		const { deliver } = recordingDelivery({ ok: false, error: "exit code 3: inbox missing" });

		const result = await runDueJobs({ dir, now: () => T0 + 61_000, deliver });

		expect(result.fired[0]).toMatchObject({ id: job.id, outcome: "failed", error: "exit code 3: inbox missing" });
		const { jobs } = await listScheduledJobs(dir);
		expect(jobs).toHaveLength(1);
		expect(jobs[0]?.state).toBe("failed");
		expect(jobs[0]?.job.lastError).toBe("exit code 3: inbox missing");
	});

	it("re-arms a recurring job at its next future slot, collapsing missed occurrences", async () => {
		const dir = await tempScheduleDir();
		const job = await createScheduledJob(dir, jobInput({ dueAt: T0, everyMs: 3_600_000 }), T0);
		const { events, deliver } = recordingDelivery();

		// The runner was down for 2.5 periods: one catch-up delivery, next slot is T0 + 3h.
		const result = await runDueJobs({ dir, now: () => T0 + 9_000_000, deliver });

		expect(events).toHaveLength(1);
		expect(result.fired[0]).toMatchObject({ id: job.id, outcome: "delivered", nextDueAt: T0 + 10_800_000 });
		expect(result.nextDueAt).toBe(T0 + 10_800_000);
		const { jobs } = await listScheduledJobs(dir);
		expect(jobs).toEqual([
			{
				state: "pending",
				job: { ...job, dueAt: T0 + 10_800_000, fireCount: 1, lastFiredAt: T0 + 9_000_000, lastError: null },
			},
		]);
	});

	it("computes the next recurring slot strictly after now", () => {
		expect(nextRecurringDueAt(T0, 60_000, T0)).toBe(T0 + 60_000);
		expect(nextRecurringDueAt(T0, 60_000, T0 - 1)).toBe(T0);
		expect(nextRecurringDueAt(T0, 60_000, T0 + 59_999)).toBe(T0 + 60_000);
	});

	it("reports a malformed job file and never fires it", async () => {
		const dir = await tempScheduleDir();
		await mkdir(join(dir, "pending"), { recursive: true });
		await writeFile(join(dir, "pending", "sch_broken.json"), "{not json", "utf8");
		const { events, deliver } = recordingDelivery();

		const result = await runDueJobs({ dir, now: () => T0, deliver });

		expect(events).toEqual([]);
		expect(result.invalid).toEqual([
			{ state: "pending", file: join("pending", "sch_broken.json"), error: "scheduled job file is not valid JSON" },
		]);
		expect(await readdir(join(dir, "pending"))).toEqual(["sch_broken.json"]);
	});

	it("delivers a due job exactly once when two runners race for it", async () => {
		const dir = await tempScheduleDir();
		await createScheduledJob(dir, jobInput(), T0);
		const { events, deliver } = recordingDelivery();

		const results = await Promise.all([
			runDueJobs({ dir, now: () => T0 + 61_000, deliver }),
			runDueJobs({ dir, now: () => T0 + 61_000, deliver }),
		]);

		expect(events).toHaveLength(1);
		expect(results.flatMap((result) => result.fired)).toHaveLength(1);
	});

	it("cancels only the owning session's job when a session id is given", async () => {
		const dir = await tempScheduleDir();
		const job = await createScheduledJob(dir, jobInput(), T0);

		expect(await cancelScheduledJob(dir, job.id, { sessionId: "session-b" })).toBeUndefined();
		expect((await listScheduledJobs(dir)).jobs).toHaveLength(1);
		expect(await cancelScheduledJob(dir, job.id, { sessionId: "session-a" })).toEqual({ state: "pending", job });
		expect((await listScheduledJobs(dir)).jobs).toEqual([]);
	});

	it.skipIf(process.platform === "win32")("writes versioned job files readable only by the owner", async () => {
		const dir = await tempScheduleDir();
		const job = await createScheduledJob(dir, jobInput(), T0);
		const path = join(dir, "pending", `${job.id}.json`);
		expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 1, id: job.id });
		expect((await stat(path)).mode & 0o777).toBe(0o600);
	});
});
