import { Agent } from "@earendil-works/pi-agent-core";
import { AgentSession } from "../../src/core/agent-session.ts";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createRpcConnectionHandler } from "../../src/modes/rpc/connection-handler.ts";
import { createHarness, type HarnessOptions } from "./harness.ts";
import { makeSink } from "./rpc-connection-harness.ts";

export async function createIdentityHarness(options: HarnessOptions = {}) {
	const harness = await createHarness({ ...options, persistSession: true, autoTitleSessions: false });
	let session = harness.session;
	let request = 0;
	const connections: ReturnType<typeof createRpcConnectionHandler>[] = [];
	const runtimes: AgentSessionRuntime[] = [];
	const bind = () => {
		const collected = makeSink();
		const runtime = new AgentSessionRuntime(
			session,
			{
				cwd: harness.tempDir,
				agentDir: session.agentDir,
				authStorage: harness.authStorage,
				modelRegistry: harness.modelRegistry,
				modelRuntime: session.modelRuntime,
				settingsManager: harness.settingsManager,
				resourceLoader: session.resourceLoader,
				diagnostics: [],
			},
			async () => {
				throw new Error("This fixture does not replace sessions through RPC");
			},
		);
		runtimes.push(runtime);
		const handler = createRpcConnectionHandler(runtime, collected.sink, {
			disposeRuntime: false,
			eventFlushScheduler: (flush) => flush(),
		});
		connections.push(handler);
		return {
			...collected,
			handler,
			async send(command: object) {
				const id = `transport-${++request}`;
				const response = collected.waitFor((record) => record.id === id, 15_000);
				await handler.handleInputLine(JSON.stringify({ ...command, id }));
				return response;
			},
		};
	};
	return {
		harness,
		get session() {
			return session;
		},
		bind,
		async reopen() {
			await session.waitForIdle();
			for (const connection of connections) await connection.dispose();
			for (const runtime of runtimes) runtime.releaseSessionHold();
			session.dispose();
			const path = harness.sessionManager.getSessionFile();
			if (!path) throw new Error("The persistent fixture has no session file");
			const manager = SessionManager.open(path);
			session = new AgentSession({
				agent: new Agent({
					initialState: { model: harness.getModel(), systemPrompt: "Test", tools: [] },
					streamFn: harness.agent.streamFunction,
					getApiKey: () => "faux-key",
				}),
				sessionManager: manager,
				settingsManager: harness.settingsManager,
				modelRuntime: harness.session.modelRuntime,
				resourceLoader: harness.session.resourceLoader,
				cwd: harness.tempDir,
				agentDir: harness.session.agentDir,
			});
			return bind();
		},
		async cleanup() {
			await session.abort();
			for (const connection of connections) await connection.dispose();
			for (const runtime of runtimes) runtime.releaseSessionHold();
			session.dispose();
			harness.cleanup();
		},
	};
}
