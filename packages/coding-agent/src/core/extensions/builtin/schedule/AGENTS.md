# builtin/schedule

Durable scheduled prompts. Unlike `loop/` (in-process timers, interactive only), a job here is a
file that outlives the process that created it, so `--print` and other headless runs can schedule.
User docs: `packages/coding-agent/docs/schedule.md`.

## FILES

- `types.ts` - `ScheduledJob`, fail-closed `parseScheduledJob` (id shape, non-negative integers, prompt size), limits, `nextRecurringDueAt`, the fired-message header. Pure.
- `store.ts` - the file layout (`pending/`, `firing/<id>@<n>~<pid>-<start>.json`, `failed/<id>@<n>.json`, `cancelled/<id>` tombstones); atomic 0600 writes in 0700 dirs; `claimOccurrence`, `rearmRecurringJob`, `settleOccurrence`, `cancelScheduledJob`.
- `runner-lease.ts` - runner leases `runners/<pid>.json` in the terminal lease format plus a heartbeat; `liveRunners`, `isWatchRunnerAvailable`, `isOwnerAmong`.
- `tool.ts` - `schedule_prompt` (create/list/cancel), flat TypeBox schema, `exposure: "search"`.
- `index.ts` - registers the tool; no session hooks, no timers.
- The runner lives with the CLI: `src/cli/schedule-runner.ts` (`runDueJobs`, deliveries, default-delivery session guard) and `src/cli/schedule-command.ts` (`senpi schedule list|cancel|run [--watch]`).

## INVARIANTS

- **At-most-once per occurrence**: claim = `rename(pending -> firing/<id>@<n>~owner)`; a racing runner gets ENOENT. Never replace the rename with read-then-write.
- **Re-arm before delivery**: a recurring job is back in `pending/` before its occurrence is delivered, so a crash loses at most that occurrence.
- **Tombstone first**: cancel writes `cancelled/<id>` before removing files; claim and re-arm re-check it after their write, so a cancelled job cannot be resurrected.
- **Abandoned, not retried**: an occurrence whose owner lease is gone moves to `failed/`; it may already have been delivered.
- **One writer per session**: the runner serializes a session's jobs, and default delivery defers while `liveSessionHolders` reports another process on the session file.
- **Fail closed**: an unparseable or oversized job file is reported (`invalid`) and never fired or deleted.
- **Session scoping**: the tool lists and cancels only the calling session's jobs; the CLI sees all.
- **No in-process firing**: the extension never arms timers.
