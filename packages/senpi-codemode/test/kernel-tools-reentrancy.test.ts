import { describe, expect, it } from "vitest";
import { RESERVED_AGENT_TOOL } from "../src/bridge/reserved.ts";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";

async function withKernel<T>(fn: (kernel: JavaScriptKernel) => Promise<T>): Promise<T> {
	const kernel = new JavaScriptKernel({
		sessionId: "kernel-tools-reentrancy",
		cwd: process.cwd(),
		parallelPoolWidth: 2,
	});
	try {
		return await fn(kernel);
	} finally {
		await kernel.close();
	}
}

describe("kernel tool reentrancy", () => {
	it("keeps a real worker parent pending on agent() while a nested lookup crosses the host bridge", async () => {
		await withKernel(async (kernel) => {
			const outer = Promise.withResolvers<void>();
			kernel.kernelToolEvents.addEventListener("outerAwaitingAgent", () => outer.resolve(), { once: true });
			const run = kernel.run({
				cellId: "parent-agent",
				code: "tool(async function lookup(path) { return await tool.read({ path }); }); return await agent('child', { tools: ['lookup'] });",
				timeoutMs: 8_000,
			});
			const agentCall = await kernel.nextToolCall();
			expect(agentCall.toolName).toBe(RESERVED_AGENT_TOOL);
			await outer.promise;
			const described = await kernel.describeKernelTools(["lookup"]);
			const descriptor = described.results[0]?.ok ? described.results[0].descriptor : undefined;
			if (!descriptor) throw new Error("lookup descriptor missing");
			const nested = Promise.withResolvers<void>();
			kernel.kernelToolEvents.addEventListener("nestedInvoke", () => nested.resolve(), { once: true });
			const invoke = kernel.invokeKernelTool({
				name: "lookup",
				kernel_generation: descriptor.kernel_generation,
				definition_revision: descriptor.definition_revision,
				args: { path: "demo.txt" },
				call_id: "fixture-child",
			});
			await nested.promise;
			const readCall = await kernel.nextToolCall();
			expect(readCall).toMatchObject({ type: "tool-call", toolName: "read", args: { path: "demo.txt" } });
			expect(readCall.callId).not.toBe(agentCall.callId);
			kernel.deliverToolReply({ type: "tool-reply", callId: readCall.callId, ok: true, value: "nested-body" });
			await expect(invoke).resolves.toBe("nested-body");
			kernel.deliverToolReply({
				type: "tool-reply",
				callId: agentCall.callId,
				ok: true,
				value: { text: "child-done" },
			});
			await expect(run).resolves.toMatchObject({ ok: true, valueRepr: '"child-done"' });
		});
	});
});
