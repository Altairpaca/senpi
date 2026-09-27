/**
 * `senpi schedule` against the REAL source CLI in a child process: the contract under test is what
 * a service manager (launchd, systemd, cron) observes when it runs the runner - stdout lines, exit
 * codes, and what the delivery hook receives - so nothing here is stubbed.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createScheduledJob,
	listScheduledJobs,
	scheduleDir,
} from "../../src/core/extensions/builtin/schedule/store.ts";

const cliEntry = join(import.meta.dirname, "..", "..", "src", "cli.ts");
const sandboxes: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
	for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
	await Promise.all(sandboxes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function sandbox(): Promise<{ root: string; agentDir: string; dir: string }> {
	const root = await mkdtemp(join(tmpdir(), "senpi-schedule-cli-"));
	sandboxes.push(root);
	const agentDir = join(root, "agent");
	return { root, agentDir, dir: scheduleDir(agentDir) };
}

function spawnCli(agentDir: string, args: string[]): ChildProcess {
	const child = spawn(process.execPath, [cliEntry, "schedule", ...args], {
		env: { ...process.env, SENPI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.push(child);
	return child;
}

function runCli(agentDir: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const child = spawnCli(agentDir, args);
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
}

function jsonLines(stdout: string): Record<string, unknown>[] {
	return stdout
		.split("\n")
		.filter((line) => line.trim().startsWith("{"))
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Resolves with the first stdout JSON line matching `predicate`, or rejects after `timeoutMs`. */
function nextJsonLine(
	child: ChildProcess,
	predicate: (line: Record<string, unknown>) => boolean,
	timeoutMs: number,
): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		let buffer = "";
		const timer = setTimeout(() => reject(new Error(`no matching line within ${timeoutMs}ms: ${buffer}`)), timeoutMs);
		child.stdout?.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			for (const line of jsonLines(buffer)) {
				if (predicate(line)) {
					clearTimeout(timer);
					resolve(line);
					return;
				}
			}
		});
	});
}

const job = (dueAt: number) => ({
	sessionId: "omocat-1553768016783867985",
	sessionFile: null,
	cwd: "/",
	prompt: "remind Howard about the PR review",
	dueAt,
	everyMs: null,
});

describe.skipIf(process.platform === "win32")("senpi schedule", () => {
	it("run --exec hands a due job to the hook as JSON on stdin, exactly once", async () => {
		const { root, agentDir, dir } = await sandbox();
		const created = await createScheduledJob(dir, job(Date.now() - 1000), Date.now() - 60_000);
		const future = await createScheduledJob(dir, job(Date.now() + 3_600_000), Date.now());
		const out = join(root, "hook-stdin.json");

		const first = await runCli(agentDir, [
			"run",
			"--exec",
			`cat > '${out}'; echo "$SENPI_SCHEDULE_SESSION_ID" > '${out}.env'`,
		]);
		const second = await runCli(agentDir, ["run", "--exec", `echo again >> '${out}.again'`]);

		expect(first.code).toBe(0);
		expect(jsonLines(first.stdout)).toEqual([
			expect.objectContaining({ event: "fired", id: created.id, outcome: "delivered" }),
		]);
		expect(JSON.parse(await readFile(out, "utf8"))).toMatchObject({
			type: "scheduled_prompt",
			id: created.id,
			sessionId: "omocat-1553768016783867985",
			prompt: "remind Howard about the PR review",
			fireCount: 1,
		});
		expect((await readFile(`${out}.env`, "utf8")).trim()).toBe("omocat-1553768016783867985");
		expect(second.code).toBe(0);
		expect(existsSync(`${out}.again`)).toBe(false);
		expect((await listScheduledJobs(dir)).jobs.map(({ job }) => job.id)).toEqual([future.id]);
	}, 60_000);

	it("run exits 1 and keeps the job in failed/ when the hook fails", async () => {
		const { agentDir, dir } = await sandbox();
		const created = await createScheduledJob(dir, job(Date.now() - 1000), Date.now() - 60_000);

		const result = await runCli(agentDir, ["run", "--exec", "echo inbox unavailable >&2; exit 7"]);

		expect(result.code).toBe(1);
		expect(jsonLines(result.stdout)).toEqual([
			expect.objectContaining({
				event: "fired",
				id: created.id,
				outcome: "failed",
				error: "exit code 7: inbox unavailable",
			}),
		]);
		expect((await listScheduledJobs(dir)).jobs).toEqual([
			expect.objectContaining({ state: "failed", job: expect.objectContaining({ id: created.id }) }),
		]);
	}, 60_000);

	it("list --json and cancel manage jobs across sessions", async () => {
		const { agentDir, dir } = await sandbox();
		const created = await createScheduledJob(dir, job(Date.now() + 600_000), Date.now());

		const listed = await runCli(agentDir, ["list", "--json"]);
		expect(listed.code).toBe(0);
		expect(JSON.parse(listed.stdout)).toMatchObject({
			jobs: [{ state: "pending", id: created.id, sessionId: "omocat-1553768016783867985" }],
			invalid: [],
			runner: { alive: false },
		});

		const cancelled = await runCli(agentDir, ["cancel", created.id]);
		const missing = await runCli(agentDir, ["cancel", created.id]);
		expect(cancelled.code).toBe(0);
		expect(missing.code).toBe(1);
		expect((await listScheduledJobs(dir)).jobs).toEqual([]);
	}, 60_000);

	it("run --watch picks up a job created after it started and stops cleanly on SIGTERM", async () => {
		const { root, agentDir, dir } = await sandbox();
		const out = join(root, "watched.json");
		const runner = spawnCli(agentDir, ["run", "--watch", "--poll-seconds", "1", "--exec", `cat > '${out}'`]);
		await nextJsonLine(runner, (line) => line.event === "watching", 30_000);
		expect(existsSync(join(dir, "runner.json"))).toBe(true);

		const fired = nextJsonLine(runner, (line) => line.event === "fired", 30_000);
		const created = await createScheduledJob(dir, job(Date.now()), Date.now());
		expect(await fired).toMatchObject({ id: created.id, outcome: "delivered" });
		expect(JSON.parse(await readFile(out, "utf8"))).toMatchObject({ id: created.id });

		const exited = new Promise<number | null>((resolve) => runner.on("close", (code) => resolve(code)));
		runner.kill("SIGTERM");
		expect(await exited).toBe(0);
		expect(existsSync(join(dir, "runner.json"))).toBe(false);
	}, 90_000);

	it("rejects an unknown subcommand with usage and exit 2", async () => {
		const { agentDir } = await sandbox();
		const result = await runCli(agentDir, ["frobnicate"]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("usage: senpi schedule");
	}, 60_000);
});
