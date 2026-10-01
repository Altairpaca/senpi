import { createServer, type Socket } from "node:net";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";
import { EvalDetachedCellManager } from "../src/tool/detached-cell-manager.ts";
import { executeEvalControl } from "../src/tool/detached-eval-result.ts";

const connected = Promise.withResolvers<void>();
const disconnected = Promise.withResolvers<void>();
const sockets = new Set<Socket>();
const server = createServer((socket) => {
	sockets.add(socket);
	socket.once("close", () => disconnected.resolve());
	connected.resolve();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (address === null || typeof address === "string") throw new Error("Missing listener address");
const mode = process.argv[2] ?? "shell";
const kernel = new JavaScriptKernel({
	sessionId: "shell-stop-qa",
	cwd: process.cwd(),
	parallelPoolWidth: 1,
	interruptBounds: { ackMs: 20_000, graceMs: mode === "late" ? 20_000 : 50, terminateDeadlineMs: 20_000 },
});
const manager = new EvalDetachedCellManager();
const childCode = `const socket = Bun.connect({hostname:"127.0.0.1",port:${address.port},socket:{data(){},open(){},close(){}}}); await socket; await new Promise(()=>{});`;
try {
	if (mode === "normal" || mode === "finished") {
		const completed = await kernel.run({
			cellId: "complete-shell",
			code: 'globalThis.saved = 41; return await Bun.$`echo normal`.text();',
			timeoutMs: 60_000,
		});
		if (mode === "finished") {
			const next = await kernel.run({ cellId: "after", code: "return globalThis.saved", timeoutMs: 60_000 });
			console.log(JSON.stringify({ completed, next }));
		} else {
			const called = kernel.nextToolCall();
			const run = kernel.run({ cellId: "normal-wait", code: "await tool.ready({});", timeoutMs: 60_000 });
			await called;
			const handle = await kernel.interrupt("stop", "normal-wait");
			const result = await run;
			const next = await kernel.run({ cellId: "after", code: "return globalThis.saved", timeoutMs: 60_000 });
			console.log(JSON.stringify({ result, retained: await handle.stateRetained, note: handle.note, next }));
		}
	} else {
	const shell = `Bun.$\`\${${JSON.stringify(process.execPath)}} -e \${${JSON.stringify(childCode)}}\``;
	const expression = mode === "lines" ? `for await (const line of ${shell}.lines()) { print(line); }`
		: mode === "text" ? `await ${shell}.text();`
		: `await ${shell};`;
	const prefix = mode === "late" ? "try { await tool.ready({}); } catch {} " : "";
	const code = `globalThis.saved = 41; ${prefix}${expression}`;
	const managed = manager.create("shell-stop", { language: "js", code, summary: "Verify shell Stop outcome" });
	manager.bindKernel(managed, kernel, () => ({
		content: [],
		details: { language: "js", durationMs: 0, toolCalls: [], truncated: false },
	}));
	const called = mode === "late" ? kernel.nextToolCall() : undefined;
	const run = kernel.run({
		cellId: "shell-stop",
		code,
		onStarted: () => manager.markRunning(managed),
		timeoutMs: 60_000,
	});
	if (called) await called;
	else await connected.promise;
	if (!manager.detach(managed)) throw new Error("Shell cell did not detach");
	const stopping = executeEvalControl(manager, { action: "stop", cell_id: "shell-stop" });
	await connected.promise;
	const control = await stopping;
	const snapshot = manager.peek("shell-stop");
	const result = await run;
	const next = await kernel.run({ cellId: "after", code: "return globalThis.saved", timeoutMs: 60_000 });
	console.log(JSON.stringify({ result, retained: snapshot.stateRetained, note: snapshot.interruptNote, control, next }));
	await Promise.race([
		disconnected.promise,
		new Promise<never>((_, reject) => {
			const timer = setTimeout(() => reject(new Error("Shell command survived Stop")), 10_000);
			timer.unref();
		}),
	]);
	console.log("COMMAND_EXITED");
	}
} finally {
	await manager.dispose();
	await kernel.close();
	for (const socket of sockets) socket.destroy();
	server.close();
}
