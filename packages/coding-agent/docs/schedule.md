# Scheduled prompts

Any senpi session can schedule a prompt to run later: a reminder, a follow-up check, or a recurring task. Scheduled prompts are stored on disk, so they work from `--print` and other headless runs and still fire after the process that scheduled them has exited.

There are two parts:

- The model schedules a prompt with the `schedule_prompt` tool. The tool only writes a job file under `<agent dir>/schedule/` and returns.
- A separate `senpi schedule run` process fires due prompts. Run it once (for example from cron), or keep it running with `--watch` (for example under launchd or systemd).

`/loop` is different: it repeats a prompt inside one interactive session with in-process timers, and it stops when that process exits.

## The `schedule_prompt` tool

`schedule_prompt` is a search-exposed tool: `tool_search` finds it for requests such as "remind me", "later", "schedule", "cron" or "recurring", and a call by name activates it.

| Parameter | Used by | Meaning |
|---|---|---|
| `action` | all | `create`, `list` (this session's jobs), or `cancel` |
| `prompt` | create | Text delivered to this session when the job fires |
| `delaySeconds` | create | Fire this many seconds from now |
| `at` | create | Absolute ISO 8601 date-time with a UTC offset, e.g. `2026-09-28T09:00:00+09:00` |
| `everySeconds` | create | Repeat every N seconds (minimum 60) |
| `id` | cancel | Job id (`sch_...`) |

`create` needs exactly one of `delaySeconds` and `at`. A due time more than a minute in the past, or more than 366 days ahead, is rejected. The result says whether a `senpi schedule run --watch` runner is currently active.

A job belongs to the session that created it. It records the session id, the session file (when the session is persisted) and the working directory.

## Running due prompts

```bash
senpi schedule run                      # fire what is due now, then exit
senpi schedule run --watch              # keep running; rescan every 15s and wake at the next due time
senpi schedule list [--json]            # every job, in every state, for all sessions
senpi schedule cancel <id>
```

`run` prints one JSON line per event on stdout:

```json
{"event":"fired","id":"sch_3f9c2a1b7d04","sessionId":"my-session","outcome":"delivered","firedAt":1790520000000,"dueAt":1790519990000}
```

A `--watch` runner also prints `{"event":"watching",...}` when it starts and `{"event":"stopped",...}` after `SIGTERM` or `SIGINT`, and writes a heartbeat to `<agent dir>/schedule/runner.json` while it runs. One-shot `run` exits `1` when any delivery failed, `2` on a usage error, and `0` otherwise.

Options:

| Option | Default | Meaning |
|---|---|---|
| `--watch` | off | Keep running |
| `--exec <command>` | none | Deliver through a shell command instead of resuming the session |
| `--poll-seconds <n>` | 15 | How often `--watch` rescans for jobs created by other processes |
| `--timeout-seconds <n>` | 900 | Time limit for one delivery |

### Default delivery: resume the session

Without `--exec`, the runner resumes the scheduling session headlessly in its working directory:

```bash
senpi -p --session <session file or id> "<message>"
```

The message is the prompt with a one-line header, `[Scheduled prompt <id>: created ..., due ..., fired ...]`, so the model can tell a scheduled turn from a user message.

### Hook delivery: `--exec`

With `--exec <command>`, the runner starts the command through the shell and writes one JSON object to its stdin:

```json
{
  "type": "scheduled_prompt",
  "id": "sch_3f9c2a1b7d04",
  "sessionId": "my-session",
  "sessionFile": "/Users/me/.senpi/agent/sessions/.../my-session.jsonl",
  "cwd": "/Users/me/project",
  "prompt": "Check whether the release workflow finished and summarize it.",
  "message": "[Scheduled prompt sch_3f9c2a1b7d04: created ..., due ..., fired ...]\nCheck whether the release workflow finished and summarize it.",
  "dueAt": 1790519990000,
  "firedAt": 1790520000000,
  "everyMs": null,
  "fireCount": 1
}
```

The command also gets `SENPI_SCHEDULE_ID`, `SENPI_SCHEDULE_SESSION_ID`, `SENPI_SCHEDULE_SESSION_FILE` and `SENPI_SCHEDULE_CWD` in its environment. Exit code `0` means delivered.

Use this when something else owns the session, for example a chat bridge that runs one headless senpi turn per incoming message: the hook hands the prompt to the bridge, which runs it in the right conversation and posts the answer.

## Delivery guarantees

- Each occurrence is delivered at most once. A runner claims a due job by renaming its file from `pending/` to `firing/`; when several runners race, exactly one claim succeeds.
- A job that became due while no runner was running fires when the next runner starts. A recurring job fires once for all missed occurrences and is then re-armed at its next future slot.
- A failed one-shot delivery moves the job to `failed/`, with the error in `lastError`, where `senpi schedule list` shows it. A failed recurring delivery is recorded in `lastError` and the job stays scheduled.
- A job file that cannot be parsed is reported by `list` and `run` and never fired.
- If a runner dies while delivering, the job stays in `firing/`. `list` shows it and `cancel` removes it; it is not retried automatically.

## Files

```text
<agent dir>/schedule/
  pending/<id>.json   waiting for its due time
  firing/<id>.json    being delivered
  failed/<id>.json    one-shot job whose delivery failed
  runner.json         heartbeat of the live --watch runner
```

Job files are written atomically with mode `0600`.
