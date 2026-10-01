// Regression: senpi#2514. Sessions outside the RPC host share one MCP service and its server
// connections, yet each session must keep its own binding: its own session ref and tool-search
// service, never the binding of whichever session attached last.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ProviderScope, runWithProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.ts";
import mcpExtension from "../../../src/core/extensions/builtin/mcp/index.ts";
import { getMcpService, resetMcpServiceForTests } from "../../../src/core/extensions/builtin/mcp/service.ts";
import { MCP_STARTUP_TIMEOUT_ENV } from "../../../src/core/extensions/builtin/mcp/startup-race.ts";
import toolSearchExtension from "../../../src/core/extensions/builtin/tool-search/index.ts";
import type { ResourceLoader } from "../../../src/core/resource-loader.ts";
import type { ExtensionAPI, LoadExtensionsResult } from "../../../src/index.ts";
import {
	cleanupRoots,
	makeRoot,
	readCounter,
	setConfig,
	stdioServer,
	type TestRoot,
} from "../../mcp/fixtures/service-lifecycle.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

const TOOL = "mcp_fx_tool_1";
const REGISTRATION_TIMEOUT_MS = 8_000;

const cleanupTasks: Array<() => Promise<void>> = [];
const open = new Set<Harness>();
const originalAgentDir = process.env[ENV_AGENT_DIR];
let root: TestRoot;
let spawnCounter: string;
let catalogGate: string;

function configureServer(extraArgs: readonly string[] = []): void {
	setConfig(root, {
		fx: {
			...stdioServer(["--tools", "2", "--spawn-counter-file", spawnCounter, ...extraArgs]),
			exposure: "search",
			lifecycle: "eager",
		},
	});
}

function configureGatedServer(): void {
	// A zero startup window backgrounds every connect, so the gated catalog lands after both sessions attached.
	vi.stubEnv(MCP_STARTUP_TIMEOUT_ENV, "0");
	configureServer(["--list-tools-gate", catalogGate]);
}

function releaseCatalog(): void {
	writeFileSync(catalogGate, "");
}

function mcpExtensions(onLoad: (pi: ExtensionAPI) => void = () => {}): Promise<LoadExtensionsResult> {
	return createTestExtensionsResult([
		{ path: "<builtin:tool-search>", factory: toolSearchExtension },
		{ path: "<builtin:mcp>", factory: mcpExtension },
		{ path: "/extensions/probe.ts", factory: onLoad },
	]);
}

function reloadableLoader(initial: LoadExtensionsResult): ResourceLoader {
	let current = initial;
	return {
		...createTestResourceLoader(),
		getExtensions: () => current,
		reload: async () => {
			current = await mcpExtensions();
		},
	};
}

async function openSession(extensionsResult?: LoadExtensionsResult): Promise<Harness> {
	const harness = await createHarness({
		resourceLoader: reloadableLoader(extensionsResult ?? (await mcpExtensions())),
	});
	open.add(harness);
	await harness.getExtensionRunner().emit({ type: "session_start", reason: "startup" });
	return harness;
}

function close(harness: Harness): void {
	open.delete(harness);
	harness.cleanup();
}

async function shutDown(harness: Harness, reason: "quit" | "new"): Promise<void> {
	await harness.getExtensionRunner().emit({ type: "session_shutdown", reason });
	close(harness);
}

async function reload(harness: Harness): Promise<void> {
	await harness.session.reload();
	await harness.getExtensionRunner().emit({ type: "session_start", reason: "reload" });
}

function registeredNames(harness: Harness): string[] {
	return harness.session.getAllTools().map(({ name }) => name);
}

function untilToolRegistered(harness: Harness, name: string): Promise<void> {
	const service = getMcpService();
	return new Promise((resolve, reject) => {
		if (registeredNames(harness).includes(name)) {
			resolve();
			return;
		}
		const timeout = setTimeout(() => {
			unsubscribe();
			reject(new Error(`${name} never registered in session ${harness.session.sessionId}`));
		}, REGISTRATION_TIMEOUT_MS);
		const unsubscribe = service.onMcpRegistrationChanged(() => {
			if (!registeredNames(harness).includes(name)) return;
			clearTimeout(timeout);
			unsubscribe();
			resolve();
		});
	});
}

async function callMcpTool(harness: Harness, value: string): Promise<string> {
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall(TOOL, { value }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt(`call ${TOOL}`);
	const result = harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "message")
		.map((entry) => entry.message)
		.find((message) => message.role === "toolResult" && message.toolName === TOOL);
	if (result === undefined) throw new Error(`no ${TOOL} result in session ${harness.session.sessionId}`);
	return getMessageText(result);
}

beforeEach(() => {
	resetMcpServiceForTests();
	root = makeRoot("2514-session-binding", cleanupTasks);
	process.env[ENV_AGENT_DIR] = root.agentDir;
	spawnCounter = join(root.agentDir, "spawns.txt");
	catalogGate = join(root.agentDir, "catalog-gate");
});

afterEach(async () => {
	for (const harness of [...open]) close(harness);
	await getMcpService().dispose("quit");
	resetMcpServiceForTests();
	vi.unstubAllEnvs();
	if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = originalAgentDir;
	await cleanupRoots(cleanupTasks);
});

describe("senpi#2514: each session binds its own view of the shared MCP service", () => {
	it("shares one server process, yet lands and activates MCP tools in each session's own tool set", async () => {
		// Given: two live sessions attach while the shared server's catalog is still loading.
		configureGatedServer();
		const alpha = await openSession();
		const bravo = await openSession();

		// When: the catalog lands, and the model in the first session calls an MCP tool by name.
		releaseCatalog();
		await untilToolRegistered(alpha, TOOL);
		await untilToolRegistered(bravo, TOOL);
		const result = await callMcpTool(alpha, "from-alpha");

		// Then: one server process serves both, and the activation stays in the session that made it.
		expect(result).toContain("fixture tool_1 value=from-alpha");
		expect(await readCounter(spawnCounter)).toBe(1);
		expect(alpha.session.getActiveToolNames()).toContain(TOOL);
		expect(bravo.session.getActiveToolNames()).not.toContain(TOOL);
		expect(registeredNames(bravo)).toContain(TOOL);
	});

	it("keeps the other session's MCP tools resolving and activating after a session reloads and is replaced", async () => {
		// Given: two live sessions attach while the catalog loads; the second reloads, then is replaced.
		configureGatedServer();
		let alphaApi: ExtensionAPI | undefined;
		const alpha = await openSession(
			await mcpExtensions((pi) => {
				alphaApi = pi;
			}),
		);
		const bravo = await openSession();
		await reload(bravo);
		await shutDown(bravo, "new");

		// When: the catalog lands, and the remaining session calls the MCP tool by name. The call goes
		// through the session's own executeTool: a reload resets the process-wide API providers, which
		// unregisters this harness's faux model.
		releaseCatalog();
		await untilToolRegistered(alpha, TOOL);
		const outcome = await alphaApi?.executeTool(TOOL, { value: "after-replacement" }, { activateInactiveTool: true });
		const result = outcome?.content.map((block) => (block.type === "text" ? block.text : "")).join("") ?? "";

		// Then: the call resolves and activates in the remaining session, with no stale-context failure.
		expect(result).toContain("fixture tool_1 value=after-replacement");
		expect(result).not.toMatch(/stale|disposed/);
		expect(alpha.session.getActiveToolNames()).toContain(TOOL);
		expect(await readCounter(spawnCounter)).toBe(1);
	});

	it("keeps the shared connection serving the remaining session when another session quits", async () => {
		// Given: two live sessions with the shared server connected and its tools registered in both.
		configureServer();
		const alpha = await openSession();
		await untilToolRegistered(alpha, TOOL);
		const bravo = await openSession();
		await untilToolRegistered(bravo, TOOL);
		const service = getMcpService();
		const connection = service.getConnection("fx");
		const pid = connection?.getRootPid();
		const generation = connection?.generation;

		// When: the second session quits the way a closed session does, and the first calls the MCP tool.
		await shutDown(bravo, "quit");
		const result = await callMcpTool(alpha, "after-quit");

		// Then: the call succeeds on the same process and connection generation: no re-spawn, no reconnect.
		expect(result).toContain("fixture tool_1 value=after-quit");
		expect(getMcpService()).toBe(service);
		expect(service.isDisposed()).toBe(false);
		expect(service.getConnection("fx")?.getRootPid()).toBe(pid);
		expect(service.getConnection("fx")?.generation).toBe(generation);
		expect(await readCounter(spawnCounter)).toBe(1);
	});

	it("still gives a provider-scoped (RPC host) session its own service, apart from the shared one", async () => {
		// Given: a classic session on the shared service, and a session loaded inside a provider scope.
		configureServer();
		const classic = await openSession();
		await untilToolRegistered(classic, TOOL);
		const shared = getMcpService();
		const scope = new ProviderScope();
		const scopedExtensions = await runWithProviderScope(scope, () => mcpExtensions());
		const scoped = await openSession(scopedExtensions);
		const scopedResult = await callMcpTool(scoped, "scoped");

		// When: the provider-scoped session quits.
		await shutDown(scoped, "quit");
		scope.close();
		const result = await callMcpTool(classic, "after-scoped-quit");

		// Then: it ran its own server process and never attached to the shared service, which keeps serving.
		expect(scopedResult).toContain("fixture tool_1 value=scoped");
		expect(await readCounter(spawnCounter)).toBe(2);
		expect(shared.getSnapshot()).toMatchObject({ disposed: false, sessionStartCount: 1 });
		expect(result).toContain("fixture tool_1 value=after-scoped-quit");
	});
});
