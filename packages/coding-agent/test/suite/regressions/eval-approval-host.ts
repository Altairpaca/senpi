import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { parseArgs } from "../../../src/cli/args.ts";
import { createCliRuntimeFactory } from "../../../src/main.ts";
import type { RpcCommand } from "../../../src/modes/rpc/rpc-types.ts";
import { SessionCommandRouter } from "../../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";

type Frame = Readonly<Record<string, unknown>>;

export async function createEvalApprovalHost() {
	const scratch = await mkdtemp(join(tmpdir(), "senpi-2512-"));
	const cwd = join(scratch, "project");
	const agentDir = join(scratch, "agent");
	await mkdir(cwd);
	await mkdir(agentDir);
	await mkdir(join(cwd, ".senpi"));
	await writeFile(join(cwd, ".senpi", "settings.json"), JSON.stringify({ permission: { eval: "allow" } }));
	await writeFile(join(cwd, ".senpi", "codemode.json"), JSON.stringify({ foregroundWindowSeconds: 1 }));
	const faux = fauxProvider({ api: "fauxapproval", provider: "fauxapproval" });
	const model = faux.getModel();
	let releaseGate = (): void => {};
	const gate = new Promise<void>((resolve) => {
		releaseGate = resolve;
	});
	const parsed = parseArgs([
		"--mode",
		"rpc",
		"--multi-session",
		"--no-skills",
		"--no-context-files",
		"--provider",
		model.provider,
		"--model",
		model.id,
		"--api-key",
		"faux-key",
		"--permission",
		"eval=allow,approval_gate=allow",
	]);
	const registry = new RpcSessionRegistry({
		agentDir,
		createRuntime: createCliRuntimeFactory(
			{ parsed, cwd, agentDir, appMode: "rpc" },
			{
				extensionFactories: [
					(pi) => {
						pi.registerProvider(faux.provider);
						pi.registerTool({
							name: "approval_gate",
							label: "Approval gate",
							description: "Wait for the test's turn boundary",
							parameters: Type.Object({}),
							async execute() {
								await gate;
								return { content: [], details: {} };
							},
						});
					},
				],
			},
		),
	});
	const client: Frame[] = [];
	const stdout: Frame[] = [];
	const listeners = new Set<(frame: Frame) => void>();
	const observe = (line: string, records: Frame[]): void => {
		const frame: Frame = JSON.parse(line);
		records.push(frame);
		for (const listener of listeners) listener(frame);
	};
	const writer = new SessionEventWriter((line) => observe(line, stdout));
	writer.registerConnection("client", {
		writeRaw: (line) => observe(line, client),
		waitForBackpressure: async () => {},
	});
	const router = new SessionCommandRouter(registry, writer, { cwd });
	let serial = 0;
	const send = async (command: RpcCommand) => {
		const id = `frame-${++serial}`;
		const result = await writer.withConnection("client", () => router.handle({ ...command, id }));
		await writer.flush();
		return result ?? client.find((frame) => frame.id === id);
	};
	const waitFor = (predicate: (frame: Frame) => boolean): Promise<Frame> =>
		new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				listeners.delete(listener);
				reject(new Error("Host approval event did not arrive"));
			}, 30_000);
			const listener = (frame: Frame): void => {
				if (!predicate(frame)) return;
				clearTimeout(timer);
				listeners.delete(listener);
				resolve(frame);
			};
			listeners.add(listener);
		});
	let sessionId: string | undefined;
	return {
		client,
		stdout,
		async headless() {
			const opened = await registry.openSession({ cwd, permissionPreset: "accept-edits" });
			const session = registry.peek(opened.sessionId)?.runtime?.session;
			if (!session) throw new Error("Headless session has no runtime");
			await session.bindExtensions({ mode: "print" });
			return await session.executeTool("eval", {
				language: "js",
				summary: "headless bash approval",
				code: 'try { await tool.bash({command: "which bun"}); } catch (error) { print("DENIED", error.message); }',
				on_timeout: "error",
			});
		},
		async run(choice: "Allow once" | "Deny", mode: "foreground" | "detached" = "foreground") {
			await send({ type: "set_client_info", capabilities: ["extension_events"] });
			faux.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall(
							"eval",
							{
								language: "js",
								summary: "run which bun with the bash tool",
								code: `${mode === "detached" ? "await tool.approval_gate({}); " : ""}try { display(await tool.bash({command: "which bun"})); } catch (error) { print("DENIED", error.message); }`,
								on_timeout: mode === "detached" ? "detach" : "error",
							},
							{ id: "approval-call" },
						),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("continued"),
				fauxAssistantMessage("detached completion received"),
			]);
			const opened = await send({ type: "open_session", cwd, permissionPreset: "accept-edits" });
			const data = opened && "data" in opened ? opened.data : undefined;
			if (typeof data !== "object" || data === null || !("sessionId" in data) || typeof data.sessionId !== "string")
				throw new Error(`Session did not open: ${JSON.stringify(opened)}`);
			sessionId = data.sessionId;
			const session = registry.peek(sessionId)?.runtime?.session;
			if (!session) throw new Error("Opened session has no runtime");
			// Warm outside any client command, as a retained kernel can outlive its creating connection.
			await session.executeTool("eval", { language: "js", code: "1", summary: "warm kernel" });
			const decision = waitFor(
				(frame) =>
					frame.type === "extension_ui_request" &&
					frame.method === "select" &&
					typeof frame.title === "string" &&
					frame.title.startsWith("Permission required: bash"),
			);
			const idle = waitFor((frame) => frame.type === "agent_idle" && frame.sessionId === sessionId);
			const turn = send({ type: "prompt", sessionId, message: "run which bun with the bash tool" });
			const settled =
				mode === "detached"
					? waitFor(
							(frame) =>
								frame.type === "extension_event" &&
								frame.name === "senpi.eval.execution" &&
								typeof frame.data === "object" &&
								frame.data !== null &&
								"detached" in frame.data &&
								frame.data.detached === true,
						)
					: undefined;
			let notificationIdle: Promise<Frame> | undefined;
			if (mode === "detached") {
				await idle;
				notificationIdle = waitFor((frame) => frame.type === "agent_idle" && frame.sessionId === sessionId);
				releaseGate();
			}
			const approval = await decision;
			// A host stdout frame is not a client approval; never answer a frame the client did not receive.
			if (!client.includes(approval)) {
				// Teardown the otherwise orphaned dialog; it was never presented to the client.
				await writer.withConnection("client", () =>
					router.handle({ type: "extension_ui_response", id: String(approval.id), sessionId, value: "Deny" }),
				);
				if (mode !== "detached") await idle;
				await turn;
				if (notificationIdle) await notificationIdle;
				throw new Error(`Approval went to host stdout, not the attached client: ${JSON.stringify(approval)}`);
			}
			const id = approval.id;
			if (typeof id !== "string") throw new Error("Approval has no request id");
			await writer.withConnection("client", () =>
				router.handle({ type: "extension_ui_response", id, sessionId, value: choice }),
			);
			if (mode !== "detached") await idle;
			await turn;
			const settledFrame = settled ? await settled : undefined;
			if (notificationIdle) await notificationIdle;
			await registry.peek(sessionId)?.runtime?.session.waitForSettledSessionWork();
			let result: unknown = client.find(
				(frame) => frame.type === "tool_execution_end" && frame.toolCallId === "approval-call",
			);
			if (mode === "detached") {
				const payload = settledFrame?.data;
				if (
					typeof payload !== "object" ||
					payload === null ||
					!("cellId" in payload) ||
					typeof payload.cellId !== "string"
				)
					throw new Error("Detached settlement has no cell id");
				result = await session.executeTool("eval", { action: "peek", cell_id: payload.cellId });
			}
			return { approval, result, sessionId };
		},
		async dispose() {
			await router.dispose();
			await rm(scratch, { recursive: true, force: true });
		},
	};
}
