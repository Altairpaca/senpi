/**
 * `release_session`: a host hands one of its sessions to a runtime outside it - `omo daemon adopt`
 * resumes it in a local terminal with `senpi --session <session_path>`.
 *
 * The hand-over is a teardown, not a transfer: nothing is replayed, the runtime is disposed and the
 * path reservation is released (the in-process one and the cross-generation claim), so the next
 * process to write the file is the one the caller starts. Before that the transcript gains one
 * `session_released` entry - a `custom` bookkeeping entry the model never sees - so the file itself
 * records which host let go of it and when. Clients still attached (only with `force`) receive
 * `session_closed { reason: "released" }`, which tells them NOT to reopen the path here.
 *
 * A session is released only when it is QUIET: no agent run, no prompt still in preflight, no admitted
 * delivery waiting to be written, no bash, compaction or barrier-held session work (the fields the
 * handoff park judges by), and no other request for the session in flight on any connection. Anything
 * else would write the file after the new writer took it. Busy is refused with nothing changed -
 * `turn_active` when a turn is running or about to start, `session_busy` for other work, both naming
 * the signals in `errorData.busy` - unless `interrupt` is set: then the run and any bash are aborted,
 * the release waits (bounded) for the run to go idle and for the other requests and prompts to
 * settle, and checks again. The last check and the close claim run in one synchronous step, so a
 * command routed after it finds the session closing, and work started before it is seen by it.
 * Also refused while clients are attached (`attached`, unless `force`) and for a session this host
 * cannot hand over (`release_unsupported`: a worker isolate owns the runtime, or there is no file).
 */
import type { AgentSession } from "../../core/agent-session.ts";
import { isHandoffBusy } from "./handoff-activity.ts";
import {
	RPC_ERROR_ATTACHED,
	RPC_ERROR_HOST_DRAINING,
	RPC_ERROR_INVALID_RELEASE_REASON,
	RPC_ERROR_RELEASE_UNSUPPORTED,
	RPC_ERROR_SESSION_BUSY,
	RPC_ERROR_SESSION_CLOSING,
	RPC_ERROR_TURN_ACTIVE,
	type RpcCommand,
	type RpcResponse,
} from "./rpc-types.ts";
import type { RpcSessionEntry } from "./session-registry.ts";

/** `customType` of the transcript entry a release appends. */
export const SESSION_RELEASED_ENTRY_TYPE = "session_released";

/** How long an `interrupt` release waits for the aborted work to settle before it re-checks. */
export const RELEASE_SETTLE_MS = 10_000;

export type ReleaseSessionCommand = Extract<RpcCommand, { type: "release_session" }>;

export type ReleaseBusySignal =
	| "turn"
	| "prompt"
	| "delivery"
	| "bash"
	| "compaction"
	| "session_work"
	| "activity"
	| "request";

/** What the router lends a release: its lookup, its request accounting, and the park teardown. */
export interface SessionReleasePort {
	readonly draining: () => boolean;
	readonly hostInstance: string | undefined;
	/** The live entry, or a throw carrying the wire code (`unknown_session`, `session_closing`). */
	lookup(sessionId: string): RpcSessionEntry;
	code(cause: unknown): string;
	/** Requests for the session in flight on any connection, the release itself not counted. */
	otherRequests(sessionId: string): number;
	otherRequestsSettled(sessionId: string): Promise<void>;
	/** `prompt` calls the session's binding started that have not settled, preflight included. */
	pendingPrompts(sessionId: string): readonly Promise<unknown>[];
	/**
	 * Claims every attachment and tears the session down, sealing it as released. Its claim is taken
	 * before its first await. `false` when another close already owns the entry.
	 */
	tearDown(sessionId: string, sessionPath: string): Promise<boolean>;
}

interface Releasable {
	readonly session: AgentSession;
	readonly sessionPath: string;
	readonly attachments: number;
}

export async function releaseSession(port: SessionReleasePort, command: ReleaseSessionCommand): Promise<RpcResponse> {
	const refuse = (code: string, data?: Readonly<Record<string, unknown>>): RpcResponse =>
		refusal(command.id, code, data);
	if (command.reason !== "takeover") return refuse(RPC_ERROR_INVALID_RELEASE_REASON);
	if (port.draining()) return refuse(RPC_ERROR_HOST_DRAINING);
	const first = releasable(port, command);
	if (!("session" in first)) return first;
	const busy = busySignals(port, command.sessionId, first.session);
	const interrupted = busy.length > 0;
	if (interrupted) {
		if (command.interrupt !== true) return refuse(busyCode(busy), { attachments: first.attachments, busy });
		await interruptAndSettle(port, command.sessionId, first.session);
	}
	const ready = releasable(port, command);
	if (!("session" in ready)) return ready;
	const stillBusy = busySignals(port, command.sessionId, ready.session);
	if (stillBusy.length > 0) {
		return refuse(busyCode(stillBusy), { attachments: ready.attachments, busy: stillBusy, interrupted });
	}
	const manager = ready.session.sessionManager;
	manager.persistHeaderNow();
	manager.appendCustomEntry(SESSION_RELEASED_ENTRY_TYPE, {
		reason: command.reason,
		interrupted,
		attachments: ready.attachments,
		host_instance: port.hostInstance ?? null,
		released_at: new Date().toISOString(),
	});
	if (!(await port.tearDown(command.sessionId, ready.sessionPath))) return refuse(RPC_ERROR_SESSION_CLOSING);
	return {
		id: command.id,
		type: "response",
		command: "release_session",
		success: true,
		data: { released: true, session_path: ready.sessionPath, attachments: ready.attachments },
	};
}

function busySignals(port: SessionReleasePort, sessionId: string, session: AgentSession): ReleaseBusySignal[] {
	const activity = session.activitySnapshot;
	const signals: ReleaseBusySignal[] = [];
	if (activity.isStreaming) signals.push("turn");
	if (port.pendingPrompts(sessionId).length > 0) signals.push("prompt");
	if (session.externalAdmission.list().pending.length > 0) signals.push("delivery");
	if (activity.isBashRunning) signals.push("bash");
	if (activity.isCompacting) signals.push("compaction");
	if (activity.hasSessionWork) signals.push("session_work");
	// The handoff park's predicate decides; a source added to it later is not missed here.
	if (signals.length === 0 && isHandoffBusy(activity)) signals.push("activity");
	if (port.otherRequests(sessionId) > 0) signals.push("request");
	return signals;
}

function busyCode(signals: readonly ReleaseBusySignal[]): string {
	return signals.some((signal) => signal === "turn" || signal === "prompt" || signal === "delivery")
		? RPC_ERROR_TURN_ACTIVE
		: RPC_ERROR_SESSION_BUSY;
}

async function interruptAndSettle(port: SessionReleasePort, sessionId: string, session: AgentSession): Promise<void> {
	session.abortBash();
	// A prompt still in preflight, or an admitted delivery, may start its run after the abort below.
	const stopStarts = session.subscribe((event) => {
		if (event.type === "agent_start") void session.abort();
	});
	let deadline: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<void>((resolve) => {
		deadline = setTimeout(resolve, RELEASE_SETTLE_MS);
	});
	try {
		await Promise.race([
			Promise.allSettled([
				session.abort().then(() => session.waitForIdle()),
				port.otherRequestsSettled(sessionId),
				...port.pendingPrompts(sessionId),
			]),
			expired,
		]);
	} finally {
		clearTimeout(deadline);
		stopStarts();
	}
}

function releasable(port: SessionReleasePort, command: ReleaseSessionCommand): Releasable | RpcResponse {
	let entry: RpcSessionEntry;
	try {
		entry = port.lookup(command.sessionId);
	} catch (cause) {
		return refusal(command.id, port.code(cause));
	}
	if (entry.state !== "open") return refusal(command.id, RPC_ERROR_SESSION_CLOSING);
	const session = entry.runtime?.session;
	if (session === undefined) return refusal(command.id, RPC_ERROR_RELEASE_UNSUPPORTED, { detail: "worker_runtime" });
	const sessionPath = entry.sessionPath ?? session.sessionFile;
	if (sessionPath === undefined) {
		return refusal(command.id, RPC_ERROR_RELEASE_UNSUPPORTED, { detail: "no_session_file" });
	}
	if (entry.attachments > 0 && command.force !== true) {
		return refusal(command.id, RPC_ERROR_ATTACHED, { attachments: entry.attachments });
	}
	return { session, sessionPath, attachments: entry.attachments };
}

function refusal(id: string | undefined, code: string, data?: Readonly<Record<string, unknown>>): RpcResponse {
	return {
		id,
		type: "response",
		command: "release_session",
		success: false,
		error: code,
		...(data && { errorCode: code, errorData: data }),
	};
}
