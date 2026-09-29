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
 * Refused, with nothing changed, while a turn runs (`turn_active`, unless `interrupt`: the turn is
 * aborted first), while clients are attached (`attached`, unless `force`), and for a session this
 * host cannot hand over (`release_unsupported`: a worker isolate owns the runtime, or the session has
 * no file). From the last check to the close claim nothing awaits, so no command can start a turn or
 * attach in between.
 */
import type { AgentSession } from "../../core/agent-session.ts";
import {
	RPC_ERROR_ATTACHED,
	RPC_ERROR_HOST_DRAINING,
	RPC_ERROR_INVALID_RELEASE_REASON,
	RPC_ERROR_RELEASE_UNSUPPORTED,
	RPC_ERROR_SESSION_CLOSING,
	RPC_ERROR_TURN_ACTIVE,
	type RpcCommand,
	type RpcResponse,
} from "./rpc-types.ts";
import type { RpcSessionEntry } from "./session-registry.ts";

/** `customType` of the transcript entry a release appends. */
export const SESSION_RELEASED_ENTRY_TYPE = "session_released";

export type ReleaseSessionCommand = Extract<RpcCommand, { type: "release_session" }>;

/** What the router lends a release: its lookup, its state, and the teardown it runs for a park. */
export interface SessionReleasePort {
	readonly draining: () => boolean;
	readonly hostInstance: string | undefined;
	/** The live entry, or a throw carrying the wire code (`unknown_session`, `session_closing`). */
	lookup(sessionId: string): RpcSessionEntry;
	code(cause: unknown): string;
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
	const interrupted = first.session.isStreaming;
	if (interrupted) {
		if (command.interrupt !== true) return refuse(RPC_ERROR_TURN_ACTIVE, { attachments: first.attachments });
		await first.session.abort();
	}
	const ready = releasable(port, command);
	if (!("session" in ready)) return ready;
	if (ready.session.isStreaming) return refuse(RPC_ERROR_TURN_ACTIVE, { attachments: ready.attachments });
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
