/**
 * `senpi schedule list|cancel|run` - the out-of-process half of durable scheduled prompts.
 *
 * The `schedule_prompt` tool only writes job files (`core/extensions/builtin/schedule/`); this
 * command fires them, so a job scheduled by a `--print` run that has long exited still runs.
 * `run` fires what is due once and exits (cron-friendly); `run --watch` stays up (launchd/systemd
 * friendly), writing a heartbeat the tool reads to tell the model whether a runner is live.
 *
 * Delivery: `--exec <command>` runs a shell command with the event as JSON on stdin (integrations
 * such as a chat bridge own the delivery); without it, the scheduling session is resumed headlessly
 * with `senpi -p --session <file|id> <message>` in the session's working directory.
 *
 * `run` prints one JSON line per event on stdout so a service log is machine-readable.
 */

import { APP_NAME, getAgentDir, isBunBinary } from "../config.ts";
import {
	type Delivery,
	execHookDelivery,
	type RunDueResult,
	runDueJobs,
	sessionResumeDelivery,
} from "../core/extensions/builtin/schedule/runner.ts";
import {
	cancelScheduledJob,
	clearRunnerHeartbeat,
	isRunnerAlive,
	listScheduledJobs,
	readRunnerHeartbeat,
	scheduleDir,
	writeRunnerHeartbeat,
} from "../core/extensions/builtin/schedule/store.ts";
import { resolveCliMainPath } from "../modes/rpc/host-lifecycle.ts";

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

const DEFAULT_POLL_SECONDS = 15;
const DEFAULT_TIMEOUT_SECONDS = 900;

const USAGE = `usage: ${APP_NAME} schedule <list|cancel|run> [options]

  list    [--json]                       every scheduled prompt, all sessions
  cancel  <id>                           remove a scheduled prompt
  run     [--watch] [--exec <command>]   fire due prompts (once, or keep running with --watch)
          [--poll-seconds <n>]           --watch rescan interval (default ${DEFAULT_POLL_SECONDS})
          [--timeout-seconds <n>]        per-delivery time limit (default ${DEFAULT_TIMEOUT_SECONDS})

Scheduled prompts are created by the schedule_prompt tool from any session, including --print runs.
With --exec, the command receives the due prompt as one JSON object on stdin (plus SENPI_SCHEDULE_ID,
SENPI_SCHEDULE_SESSION_ID, SENPI_SCHEDULE_SESSION_FILE, SENPI_SCHEDULE_CWD); exit 0 means delivered.
Without --exec, the scheduling session is resumed headlessly: ${APP_NAME} -p --session <session> <prompt>.`;

class UsageError extends Error {}

function writeLine(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function positiveInteger(flag: string, value: string | undefined): number {
	const parsed = Number(value);
	if (value === undefined || !Number.isInteger(parsed) || parsed < 1) {
		throw new UsageError(`${flag} needs a positive integer`);
	}
	return parsed;
}

interface RunOptions {
	readonly watch: boolean;
	readonly exec: string | undefined;
	readonly pollSeconds: number;
	readonly timeoutSeconds: number;
}

function parseRunOptions(args: readonly string[]): RunOptions {
	let watch = false;
	let exec: string | undefined;
	let pollSeconds = DEFAULT_POLL_SECONDS;
	let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--watch") watch = true;
		else if (arg === "--exec") {
			exec = args[++index];
			if (exec === undefined || exec.trim().length === 0) throw new UsageError("--exec needs a command");
		} else if (arg === "--poll-seconds") pollSeconds = positiveInteger(arg, args[++index]);
		else if (arg === "--timeout-seconds") timeoutSeconds = positiveInteger(arg, args[++index]);
		else throw new UsageError(`unknown option for run: ${arg}`);
	}
	return { watch, exec, pollSeconds, timeoutSeconds };
}

function resolveDelivery(options: RunOptions): Delivery {
	const timeoutMs = options.timeoutSeconds * 1000;
	if (options.exec !== undefined) return execHookDelivery(options.exec, timeoutMs);
	return sessionResumeDelivery(
		{ command: process.execPath, args: isBunBinary ? [] : [...process.execArgv, resolveCliMainPath()] },
		timeoutMs,
	);
}

function report(result: RunDueResult): boolean {
	for (const invalid of result.invalid) writeLine({ event: "invalid", ...invalid });
	for (const fired of result.fired) writeLine({ event: "fired", ...fired });
	return result.fired.every((fired) => fired.outcome === "delivered");
}

async function runOnce(dir: string, deliver: Delivery): Promise<number> {
	const result = await runDueJobs({ dir, now: Date.now, deliver });
	return report(result) ? EXIT_OK : EXIT_FAILED;
}

async function runWatch(dir: string, deliver: Delivery, options: RunOptions): Promise<number> {
	const startedAt = Date.now();
	const heartbeat = () =>
		writeRunnerHeartbeat(dir, { pid: process.pid, startedAt, beatAt: Date.now(), exec: options.exec ?? null });
	let stopping = false;
	let wake: (() => void) | undefined;
	const stop = () => {
		stopping = true;
		wake?.();
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	try {
		await heartbeat();
		writeLine({ event: "watching", pid: process.pid, dir, pollSeconds: options.pollSeconds });
		while (!stopping) {
			const result = await runDueJobs({ dir, now: Date.now, deliver });
			report(result);
			await heartbeat();
			if (stopping) break;
			const untilDue = result.nextDueAt === undefined ? Number.POSITIVE_INFINITY : result.nextDueAt - Date.now();
			const waitMs = Math.max(0, Math.min(options.pollSeconds * 1000, untilDue));
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, waitMs);
				wake = () => {
					clearTimeout(timer);
					resolve();
				};
			});
			wake = undefined;
		}
	} finally {
		process.off("SIGTERM", stop);
		process.off("SIGINT", stop);
		await clearRunnerHeartbeat(dir, process.pid);
	}
	writeLine({ event: "stopped", pid: process.pid });
	return EXIT_OK;
}

function formatRelative(ms: number): string {
	const minutes = Math.round(Math.abs(ms) / 60_000);
	const text =
		minutes < 60 ? `${minutes}m` : minutes < 2880 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`;
	return ms >= 0 ? `in ${text}` : `${text} ago`;
}

async function list(dir: string, json: boolean): Promise<number> {
	const { jobs, invalid } = await listScheduledJobs(dir);
	const heartbeat = await readRunnerHeartbeat(dir);
	const alive = await isRunnerAlive(dir);
	if (json) {
		writeLine({
			jobs: jobs.map(({ state, job }) => ({ state, ...job })),
			invalid,
			runner: alive && heartbeat !== undefined ? { alive, pid: heartbeat.pid, exec: heartbeat.exec } : { alive },
		});
		return EXIT_OK;
	}
	const now = Date.now();
	const lines = jobs.map(({ state, job }) => {
		const every = job.everyMs === null ? "" : ` every ${Math.round(job.everyMs / 1000)}s`;
		const error = job.lastError === null ? "" : ` (last error: ${job.lastError})`;
		return `${job.id}  ${state}  ${new Date(job.dueAt).toISOString()} (${formatRelative(job.dueAt - now)})${every}  session ${job.sessionId}${error}\n    ${job.prompt.split("\n")[0]}`;
	});
	for (const bad of invalid) lines.push(`${bad.file}  invalid: ${bad.error}`);
	if (lines.length === 0) lines.push("No scheduled prompts.");
	lines.push(
		alive
			? `Runner: active (pid ${heartbeat?.pid})`
			: `Runner: none (start one with \`${APP_NAME} schedule run --watch\`)`,
	);
	process.stdout.write(`${lines.join("\n")}\n`);
	return EXIT_OK;
}

async function cancel(dir: string, id: string | undefined): Promise<number> {
	if (id === undefined) throw new UsageError("cancel needs a job id");
	const removed = await cancelScheduledJob(dir, id);
	if (removed === undefined) {
		process.stderr.write(`No scheduled prompt ${id}.\n`);
		return EXIT_FAILED;
	}
	process.stdout.write(`Cancelled ${id} (${removed.state}).\n`);
	return EXIT_OK;
}

/** Runs `senpi schedule ...` (argv without the leading `schedule`) and returns the exit code. */
export async function runScheduleCommand(args: readonly string[]): Promise<number> {
	const dir = scheduleDir(getAgentDir());
	const [subcommand, ...rest] = args;
	try {
		switch (subcommand) {
			case "list":
				if (rest.some((arg) => arg !== "--json"))
					throw new UsageError(`unknown option for list: ${rest.join(" ")}`);
				return await list(dir, rest.includes("--json"));
			case "cancel":
				if (rest.length > 1) throw new UsageError("cancel takes exactly one job id");
				return await cancel(dir, rest[0]);
			case "run": {
				const options = parseRunOptions(rest);
				const deliver = resolveDelivery(options);
				return options.watch ? await runWatch(dir, deliver, options) : await runOnce(dir, deliver);
			}
			case "--help":
			case "-h":
			case "help":
				process.stdout.write(`${USAGE}\n`);
				return EXIT_OK;
			default:
				throw new UsageError(subcommand === undefined ? "missing subcommand" : `unknown subcommand: ${subcommand}`);
		}
	} catch (error) {
		if (error instanceof UsageError) {
			process.stderr.write(`${error.message}\n${USAGE}\n`);
			return EXIT_USAGE;
		}
		throw error;
	}
}
