/**
 * A delivery whose transcript entry the session file refuses (a real `chmod 0444`, so EACCES), on a REAL
 * in-process host (real `AgentSession`, real extension drain, real admission ledger): the delivery is
 * settled as failed with the error instead of staying `pending` forever, so it no longer counts as a held
 * start; the next delivery starts its own turn and reaches disk once the file is writable; and the failed
 * one is admitted again only after the file has taken a later entry, so it is redelivered rather than lost.
 */
import { chmodSync, readFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { gatewayFixture } from "./rpc-release-gateway-fixture.ts";
import { nextEvent, startReleaseHost } from "./rpc-release-host-support.ts";

const unprivileged = process.platform !== "win32" && process.getuid?.() !== 0;

describe.skipIf(!unprivileged)("a delivery whose entry the session file refuses", () => {
	it("is settled as failed, does not hold later deliveries, and is redelivered once the file takes writes", async () => {
		// Given: a quiet session whose file refuses writes.
		const gateway = gatewayFixture();
		await using host = await startReleaseHost(gateway.extension);
		host.faux.setResponses([
			fauxAssistantMessage("seed reply"),
			fauxAssistantMessage("refused reply"),
			fauxAssistantMessage("ok reply"),
			fauxAssistantMessage("redelivered reply"),
		]);
		const { sessionId, sessionPath, session } = await host.open("refused-delivery");
		chmodSync(sessionPath, 0o444);

		// When: a delivery starts a turn whose entries the file refuses.
		let settled = nextEvent(session, "agent_settled");
		const refused = await host.send({ type: "wake", id: "w1", sessionId, delivery_ids: ["refused-1"] });
		await settled;
		chmodSync(sessionPath, 0o644);

		// Then: it is not held; it is failed with the write error.
		expect(refused).toMatchObject({ data: { admitted: [{ delivery_id: "refused-1", kind: "started" }] } });
		const afterRefusal = session.externalAdmission.list();
		expect(afterRefusal).toMatchObject({ pending: [], emitted: [], failed: [{ delivery_id: "refused-1" }] });
		expect(afterRefusal.failed?.[0]?.error).toMatch(/^EACCES/);

		// When: the next delivery arrives with the file writable again.
		settled = nextEvent(session, "agent_settled");
		const next = await host.send({ type: "wake", id: "w2", sessionId, delivery_ids: ["ok-1"] });

		// Then: it starts its own turn and reaches disk, which makes the refused one admissible again.
		expect(next).toMatchObject({ data: { admitted: [{ delivery_id: "ok-1", kind: "started" }] } });
		await settled;
		expect(readFileSync(sessionPath, "utf8")).toContain("DELIVERY ok-1");
		expect(session.externalAdmission.list()).toEqual({ pending: [], emitted: ["ok-1"] });

		// When: the sender redelivers the refused one.
		settled = nextEvent(session, "agent_settled");
		const redelivered = await host.send({ type: "wake", id: "w3", sessionId, delivery_ids: ["refused-1"] });

		// Then: it is admitted, written once, and emitted.
		expect(redelivered).toMatchObject({ data: { admitted: [{ delivery_id: "refused-1", kind: "started" }] } });
		await settled;
		const text = readFileSync(sessionPath, "utf8");
		expect(text.split("DELIVERY refused-1").length - 1).toBe(1);
		expect(session.externalAdmission.list()).toEqual({ pending: [], emitted: ["ok-1", "refused-1"] });
	});

	it("answers already_admitted for a failed delivery while the file has taken no later entry", async () => {
		// Given: a delivery the file refused, and a file that still refuses writes.
		const gateway = gatewayFixture();
		await using host = await startReleaseHost(gateway.extension);
		host.faux.setResponses([fauxAssistantMessage("seed reply"), fauxAssistantMessage("refused reply")]);
		const { sessionId, sessionPath, session } = await host.open("refused-loop");
		chmodSync(sessionPath, 0o444);
		const settled = nextEvent(session, "agent_settled");
		await host.send({ type: "wake", id: "w1", sessionId, delivery_ids: ["refused-1"] });
		await settled;

		// When: a wake names it again before anything was written.
		const again = await host.send({ type: "wake", id: "w2", sessionId, delivery_ids: ["refused-1"] });
		chmodSync(sessionPath, 0o644);

		// Then: no second turn runs against a file that refuses it; the delivery stays failed.
		expect(again).toMatchObject({ data: { admitted: [{ delivery_id: "refused-1", kind: "already_admitted" }] } });
		expect(session.externalAdmission.list()).toMatchObject({ pending: [], failed: [{ delivery_id: "refused-1" }] });
	});
});
