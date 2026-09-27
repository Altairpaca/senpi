/**
 * The host identity a REAL socket host stamps into every session's context: the endpoint (stable
 * across a generation handoff) and the generation (not), overwriting whatever a client claimed.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handoffHost } from "../src/modes/rpc/host-handoff.ts";
import { probeHost } from "../src/modes/rpc/host-probe.ts";
import { JsonlPeer, openedSessionId, type WireRecord } from "./helpers/rpc-generation-support.ts";
import {
	canonicalSocket,
	type EndpointScratch,
	endpointScratch,
	hostArgs,
	hostEnv,
	realHost,
	supervisorLaunch,
	sweepEndpointScratches,
	tracked,
	trackSupervisor,
} from "./helpers/rpc-host-endpoint-scratch.ts";

const PROBE_EXTENSION = `export default function (pi) {
	pi.rpc.handle("probe.identity", () => ({ context: pi.sessionContext }));
}`;

afterEach(sweepEndpointScratches, 180_000);

describe.skipIf(process.platform === "win32")("host identity in every session's context", () => {
	it("gives an extension the endpoint and generation, stable across a handoff, and never the client's forgery", async () => {
		const qa = endpointScratch("ctx");
		const extension = join(qa.root, "probe.mjs");
		await writeFile(extension, PROBE_EXTENSION);
		await realHost(qa, qa.legacy, { extension });
		const first = await probeHost({ socket: qa.legacy });

		const before = await probeContext(qa, { host_socket: "/forged", host_instance: "forged", role: "kept" });
		expect(before).toEqual({
			host_socket: canonicalSocket(qa.legacy),
			host_instance: first?.instanceId,
			role: "kept",
		});

		const successor = await handoffHost({
			socket: qa.legacy,
			agentDir: qa.agentDir,
			hostArgs: hostArgs(extension),
			env: hostEnv(qa),
			_test: { launch: supervisorLaunch, readinessTimeoutMs: 60_000 },
		});
		if (successor.action !== "handoff") throw new Error(`handoff refused: ${JSON.stringify(successor)}`);
		trackSupervisor(successor.pid);
		const after = await probeContext(qa, {});

		expect(after.host_socket).toBe(before.host_socket);
		expect(after.host_instance).toBe(successor.instanceId);
		expect(after.host_instance).not.toBe(before.host_instance);
	}, 180_000);
});

async function probeContext(qa: EndpointScratch, context: Record<string, string>): Promise<Record<string, unknown>> {
	const client = await JsonlPeer.connect(qa.legacy);
	tracked.peers.push(client);
	const sessionId = openedSessionId(await client.request({ id: "open", type: "open_session", cwd: qa.cwd, context }));
	const reply: WireRecord = await client.request({
		id: "probe",
		type: "extension_request",
		name: "probe.identity",
		sessionId,
	});
	const data = reply.data as { context?: Record<string, unknown> } | undefined;
	if (reply.success !== true || data?.context === undefined) throw new Error(`probe failed: ${JSON.stringify(reply)}`);
	return data.context;
}
