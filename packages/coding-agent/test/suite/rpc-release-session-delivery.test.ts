/**
 * `release_session` against gateway deliveries, on a REAL in-process host (real `AgentSession`, real
 * extension drain, real admission ledger and agent queues): a drain pass still running when the
 * release decides admits nothing after the claim, so nothing follows `session_released` and the
 * delivery stays with its sender; `interrupt` takes queued deliveries and queued user text out of the
 * session and hands both back in `dropped`, so neither vanishes nor lands on disk.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { ExtensionFactory, SessionControlAdmission } from "../../src/core/extensions/types.ts";
import { RELEASED_ADMISSION_CLOSED } from "../../src/modes/rpc/session-release.ts";
import { afterReleased, heldTurn, nextEvent, startReleaseHost } from "./rpc-release-host-support.ts";

function gatewayFixture() {
	let armed: { entered: () => void; go: Promise<void> } | undefined;
	const outcomes: string[] = [];
	let inboxDir = "";
	const extension: ExtensionFactory = (pi) => {
		pi.on("session_start", async (_event, ctx) => {
			inboxDir = join(`${ctx.sessionManager.getSessionFile() ?? "session"}.inbox`);
			await pi.session.registerControlEndpoint({
				inboxDir,
				drain: async (event) => {
					const admitted: SessionControlAdmission[] = [];
					const late = armed;
					if (late !== undefined && event.reasons.includes("inbox")) {
						armed = undefined;
						late.entered();
						await late.go;
					}
					for (const deliveryId of [...(event.delivery_ids ?? []), ...(late ? ["late-1"] : [])]) {
						try {
							const result = pi.session.admitExternalMessage({
								delivery_id: deliveryId,
								text: `DELIVERY ${deliveryId}`,
								deliverAs: "followUp",
							});
							outcomes.push(`${deliveryId}:${result.kind}`);
							admitted.push({ delivery_id: deliveryId, kind: result.kind });
						} catch (error) {
							outcomes.push(`${deliveryId}:refused:${error instanceof Error ? error.message : String(error)}`);
						}
					}
					return { admitted };
				},
			});
		});
	};
	return {
		extension,
		outcomes,
		armLateDrain(): { entered: Promise<void>; go: () => void; wake: () => void } {
			let entered!: () => void;
			const enteredPromise = new Promise<void>((resolve) => {
				entered = resolve;
			});
			let go!: () => void;
			const goPromise = new Promise<void>((resolve) => {
				go = resolve;
			});
			armed = { entered, go: goPromise };
			return { entered: enteredPromise, go, wake: () => writeFileSync(join(inboxDir, "late-1"), "marker") };
		},
	};
}

describe("release_session and gateway deliveries (real host)", () => {
	it("a drain pass that admits during the teardown is refused: nothing follows session_released", async () => {
		// Given: a quiet, detached session whose drain pass is mid-flight (woken, not yet admitting).
		const gateway = gatewayFixture();
		await using host = await startReleaseHost(gateway.extension);
		host.faux.setResponses([fauxAssistantMessage("seed reply"), fauxAssistantMessage("late reply")]);
		const { sessionId, sessionPath, session } = await host.open("late-drain");
		const late = gateway.armLateDrain();
		late.wake();
		await late.entered;

		// When: the release decides and claims, and only then does the drain try to admit.
		const reply = host.release(sessionId);
		late.go();

		// Then: released; the admission was refused; no delivery entry, reply or anything else after the release.
		expect(await reply).toMatchObject({ success: true, data: { released: true } });
		expect(gateway.outcomes).toEqual([`late-1:refused:${RELEASED_ADMISSION_CLOSED}`]);
		expect(afterReleased(sessionPath)).toEqual([]);
		expect(session.externalAdmission.list()).toEqual({ pending: [], emitted: [] });
	});

	it("interrupt drops a queued delivery out of the session, releases, and reports it for redelivery", async () => {
		// Given: a turn running and a delivery admitted into its follow-up queue.
		const gateway = gatewayFixture();
		await using host = await startReleaseHost(gateway.extension);
		host.faux.setResponses([fauxAssistantMessage("seed reply"), heldTurn]);
		const { sessionId, sessionPath, session } = await host.open("queued-delivery");
		const started = nextEvent(session, "agent_start");
		await host.send({ type: "prompt", id: "work", sessionId, message: "long work" });
		await started;
		expect(await host.send({ type: "wake", id: "w", sessionId, delivery_ids: ["q-1"] })).toMatchObject({
			success: true,
			data: { admitted: [{ delivery_id: "q-1", kind: "queued" }] },
		});

		// When: the release interrupts.
		const reply = await host.release(sessionId, { interrupt: true });

		// Then: released, the delivery reported as dropped, never written, and nothing after session_released.
		expect(reply).toMatchObject({
			success: true,
			data: { released: true, dropped: { deliveries: ["q-1"], user_messages: [] } },
		});
		expect(session.externalAdmission.list()).toEqual({ pending: [], emitted: [] });
		expect(readFileSync(sessionPath, "utf8")).not.toContain("DELIVERY q-1");
		expect(afterReleased(sessionPath)).toEqual([]);
	});

	it("interrupt hands the user's queued steer and follow-up text back instead of dropping it silently", async () => {
		// Given: a turn running with user text queued behind it.
		const gateway = gatewayFixture();
		await using host = await startReleaseHost(gateway.extension);
		host.faux.setResponses([fauxAssistantMessage("seed reply"), heldTurn]);
		const { sessionId, sessionPath, session } = await host.open("queued-user");
		const started = nextEvent(session, "agent_start");
		await host.send({ type: "prompt", id: "work", sessionId, message: "long work" });
		await started;
		await host.send({ type: "steer", id: "s", sessionId, message: "USER STEER TEXT" });
		await host.send({ type: "follow_up", id: "f", sessionId, message: "USER FOLLOW TEXT" });

		// When: the release interrupts.
		const reply = await host.release(sessionId, { interrupt: true });

		// Then: both texts come back in enqueue order, neither is on disk, nothing follows the release.
		expect(reply).toMatchObject({
			success: true,
			data: { released: true, dropped: { deliveries: [], user_messages: ["USER STEER TEXT", "USER FOLLOW TEXT"] } },
		});
		const file = readFileSync(sessionPath, "utf8");
		expect(file).not.toContain("USER STEER TEXT");
		expect(file).not.toContain("USER FOLLOW TEXT");
		expect(afterReleased(sessionPath)).toEqual([]);
	});
});
