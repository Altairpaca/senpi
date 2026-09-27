# builtin/schedule

Durable scheduled prompts. Unlike `loop/` (in-process timers, interactive only), a job here is a
file that outlives the process that created it, so `--print` and other headless runs can schedule.
User docs: `packages/coding-agent/docs/schedule.md`.

## FILES

- `types.ts` - `ScheduledJob`, fail-closed `parseScheduledJob`, `nextRecurringDueAt`, the fired-message header. Pure.
- `store.ts` - one file per job under `<agentDir>/schedule/{pending,firing,failed}/`, the directory IS the state; atomic writes via `writeAtomic` (0600); runner heartbeat `runner.json`.
- `runner.ts` - `runDueJobs` (clock and delivery injected), `execHookDelivery` (`--exec`: event JSON on stdin), `sessionResumeDelivery` (default: `senpi -p --session`).
- `tool.ts` - `schedule_prompt` (create/list/cancel), flat TypeBox schema, `exposure: "search"`.
- `index.ts` - registers the tool; no session hooks, no timers.
- The runner CLI is `src/cli/schedule-command.ts` (`senpi schedule list|cancel|run [--watch]`).

## INVARIANTS

- **At-most-once per occurrence**: a runner claims a due job by `rename(pending -> firing)`; a racing runner gets ENOENT and skips. Never replace the rename with read-then-write.
- **Missed occurrences collapse**: a recurring job fires once, then re-arms at the first slot after `now`.
- **Fail closed**: an unparseable job file is reported (`invalid`) and never fired or deleted.
- **Session scoping**: the tool lists and cancels only jobs whose `sessionId` is the calling session; the CLI sees all.
- **No in-process firing**: the extension never arms timers, so a live interactive session and a runner cannot double-deliver.
