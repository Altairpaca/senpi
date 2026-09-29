/**
 * A real in-process host for the release suites: the production router, registry, writer and session
 * binding over REAL `AgentSession`s (faux provider, real extension runner, real admission ledger and
 * queues), so an extension's drain, the agent-level queue and the teardown window all run the code
 * the daemon runs. Sessions are opened retained and then detached, as `omo daemon adopt` finds them.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FauxProviderRegistration,
	type FauxResponseStep,
	fauxAssistantMessage,
	registerFauxProvider,
} from "@earendil-works/pi-ai/compat";
import type { AgentSession } from "../../src/core/agent-session.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { RpcCommand } from "../../src/modes/rpc/rpc-types.ts";
import { SessionCommandRouter } from "../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../src/modes/rpc/session-registry.ts";
import { SESSION_RELEASED_ENTRY_TYPE } from "../../src/modes/rpc/session-release.ts";

type WireRecord = Record<string, unknown> & { id?: string; type?: string };

export interface OpenedSession {
	readonly sessionId: string;
	readonly sessionPath: string;
	readonly session: AgentSession;
}

export const heldTurn: FauxResponseStep = (_context, options) =>
	new Promise((resolve) => {
		const settle = (): void => resolve(fauxAssistantMessage("held turn ended"));
		if (options?.signal?.aborted) settle();
		else options?.signal?.addEventListener("abort", settle, { once: true });
	});

export async function startReleaseHost(extension: ExtensionFactory) {
	const dir = await mkdtemp(join(tmpdir(), "senpi-release-host-"));
	const cwd = join(dir, "cwd");
	await mkdir(cwd);
	const faux: FauxProviderRegistration = registerFauxProvider();
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: join(dir, "models.json") });
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: model.api,
		models: [
			{
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			},
		],
	});
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd: sessionCwd,
		sessionManager,
		sessionStartEvent,
	}) => {
		const services = await createAgentSessionServices({
			agentDir: dir,
			cwd: sessionCwd,
			modelRuntime,
			resourceLoaderOptions: {
				extensionFactories: [extension],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		return {
			...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model })),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const registry = new RpcSessionRegistry({ agentDir: dir, createRuntime, closeGraceMs: 2_000 });
	const records: WireRecord[] = [];
	const answerWaiters = new Map<string, (record: WireRecord) => void>();
	const receive = (line: string): void => {
		const record = JSON.parse(line) as WireRecord;
		records.push(record);
		if (record.type === "response" && typeof record.id === "string") answerWaiters.get(record.id)?.(record);
	};
	const writer = new SessionEventWriter(receive);
	// Session-scoped commands need no attachment: this connection sends them, like a gateway client.
	writer.registerConnection("driver", { writeRaw: receive, waitForBackpressure: async () => {} });
	const router = new SessionCommandRouter(registry, writer, {
		cwd,
		hostContext: { host_socket: join(dir, "host.sock"), host_instance: "release-test-host" },
	});
	let serial = 0;

	const send = async (command: RpcCommand & { id: string }): Promise<WireRecord> => {
		const answered = new Promise<WireRecord>((resolve) => answerWaiters.set(command.id, resolve));
		const direct = await writer.withConnection("driver", () => router.handle(command));
		await writer.flush();
		const answer = (direct as WireRecord | undefined) ?? (await answered);
		answerWaiters.delete(command.id);
		return answer;
	};

	return {
		faux,
		router,
		send,
		async open(name: string): Promise<OpenedSession> {
			const connection = `open-${name}`;
			writer.registerConnection(connection, { writeRaw: receive, waitForBackpressure: async () => {} });
			const id = `open-${++serial}`;
			const sessionPath = join(dir, `${name}.jsonl`);
			await writer.withConnection(connection, () =>
				router.handle({ type: "open_session", id, cwd, sessionPath, retain_on_disconnect: true }),
			);
			await writer.flush();
			const reply = records.find((record) => record.id === id);
			const data = reply?.data as { sessionId?: string; state?: { sessionFile?: string } } | undefined;
			const sessionId = data?.sessionId;
			const session = sessionId === undefined ? undefined : registry.peek(sessionId)?.runtime?.session;
			if (sessionId === undefined || session === undefined) throw new Error(`open failed: ${JSON.stringify(reply)}`);
			const idle = nextEvent(session, "agent_idle");
			await send({ type: "prompt", id: `seed-${serial}`, sessionId, message: "seed the transcript" });
			await idle;
			writer.unregisterConnection(connection);
			await router.releaseConnection(connection);
			return { sessionId, sessionPath: data?.state?.sessionFile ?? sessionPath, session };
		},
		release(sessionId: string, fields: { interrupt?: boolean } = {}): Promise<WireRecord> {
			return send({ type: "release_session", id: `release-${++serial}`, sessionId, reason: "takeover", ...fields });
		},
		async [Symbol.asyncDispose]() {
			await router.dispose();
			faux.unregister();
			await rm(dir, { recursive: true, force: true });
		},
	};
}

export function nextEvent(session: AgentSession, type: string): Promise<void> {
	return new Promise((resolve) => {
		const unsubscribe = session.subscribe((event) => {
			if (event.type !== type) return;
			unsubscribe();
			resolve();
		});
	});
}

export function afterReleased(sessionPath: string): string[] | null {
	const kinds = SessionManager.open(sessionPath)
		.getEntries()
		.map((entry) =>
			entry.type === "custom"
				? `custom:${entry.customType}`
				: entry.type === "custom_message"
					? `custom_message:${entry.customType}`
					: entry.type === "message"
						? `message:${entry.message.role}`
						: entry.type,
		);
	const index = kinds.indexOf(`custom:${SESSION_RELEASED_ENTRY_TYPE}`);
	return index === -1 ? null : kinds.slice(index + 1);
}
