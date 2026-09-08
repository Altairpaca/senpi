import { expect, it } from "vitest";
import { startWorkerHost } from "./rpc-worker-host-support.ts";

it("reports oversized worker output as a session-specific failure without terminating siblings", async () => {
	const host = await startWorkerHost(`export default function (pi) {
		pi.registerCommand("overflow", { description: "test output bound", handler: async (_args, ctx) => {
			ctx.ui.notify("x".repeat(16 * 1024 * 1024), "info");
		} });
	}`);
	try {
		const a = await host.request({ type: "open_session", cwd: host.cwd });
		const b = await host.request({ type: "open_session", cwd: host.cwd });
		expect(a.success).toBe(true);
		expect(b.success).toBe(true);
		const failure = host.wait((record) => record.type === "session_error" && record.sessionId === a.data?.sessionId);
		const command = host.request({ type: "prompt", sessionId: a.data?.sessionId, message: "/overflow" });
		const results = Promise.allSettled([failure, command]);
		expect((await failure).error).toBe("session_worker_output_limit");
		expect((await command).success).toBe(false);
		await results;
		const sibling = await host.request({ type: "get_state", sessionId: b.data?.sessionId });
		expect(sibling.success).toBe(true);
		expect(sibling.data?.sessionId).toBe(b.data?.state?.sessionId);
	} finally {
		await host.dispose();
	}
}, 60_000);
