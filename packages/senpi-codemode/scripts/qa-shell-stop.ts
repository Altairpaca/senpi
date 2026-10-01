import { createServer, type Socket } from "node:net";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";

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
const kernel = new JavaScriptKernel({
	sessionId: "shell-stop-qa",
	cwd: process.cwd(),
	parallelPoolWidth: 1,
	interruptBounds: { ackMs: 20_000, graceMs: 50, terminateDeadlineMs: 20_000 },
});
const mode = process.argv[2] ?? "shell";
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
	const run = kernel.run({
		cellId: "shell-stop",
		code: `globalThis.saved = 41; ${expression}`,
		timeoutMs: 60_000,
	});
	await connected.promise;
	const handle = await kernel.interrupt("stop", "shell-stop");
	const result = await run;
	const next = await kernel.run({ cellId: "after", code: "return globalThis.saved", timeoutMs: 60_000 });
	console.log(JSON.stringify({ result, retained: await handle.stateRetained, note: handle.note, next }));
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
	await kernel.close();
	for (const socket of sockets) socket.destroy();
	server.close();
}
