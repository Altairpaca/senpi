#!/usr/bin/env node
/**
 * Scenario `owner-drop`: the connection that OPENED the session is killed
 * while a blocking question is pending and other connections are attached.
 * Spec: the question is session-owned and must survive (docs/rpc.md: pending
 * questions are broadcast to all attached connections and survive the message).
 * Declared defect: the router cancels pending questions on ANY owner drop.
 */

import { makeSandbox, spawnSenpiHost } from "./lib/rpc-host.mjs";
import { connect, isQuestionFrame, openSession, readFixtureLog, teardown } from "./lib/probe-support.mjs";
import { delay } from "./lib/rpc-socket-client.mjs";

const OWNER_DROP_DEFECT = {
	id: "owner-drop-cancels-pending-questions",
	expect: "with B still attached, dropping A leaves the question pending; C can still answer it",
	reference: "src/modes/rpc/session-command-router.ts:416 (releaseConnection cancels the shared binding's pending UI requests unconditionally, before the refcount decides the session survives)",
};

export async function runOwnerDrop(report) {
	report.declareDefect(OWNER_DROP_DEFECT);
	const sandbox = makeSandbox("owner-drop");
	report.info("sandbox", { dir: sandbox.dir, socketPath: sandbox.socketPath });
	const host = await spawnSenpiHost({ sandbox, onLog: (line) => report.observe("host", "host", line) });
	let a;
	let b;
	let c;
	try {
		a = await connect(sandbox.socketPath, "A", report);
		const opened = await openSession(a, { cwd: sandbox.work });
		const sessionId = opened.data.sessionId;
		const sessionPath = opened.data.state.sessionFile;
		const markAsk = a.mark();
		await a.request({ type: "prompt", sessionId, message: "/askq wait=true label=drop1" });
		const frame = await a.waitFor(isQuestionFrame, markAsk);

		b = await connect(sandbox.socketPath, "B", report);
		const markB = b.mark();
		await openSession(b, { sessionPath, cwd: sandbox.work });
		await b.waitForStable(isQuestionFrame, markB, 1, 1_000);
		report.pass("question-live-with-two-connections", { id: frame.id });

		const markDrop = b.mark();
		a.close();
		await delay(2_000);
		const cancelled = b.find(markDrop, (message) => message.type === "question_resolved" && message.id === frame.id);
		if (cancelled) {
			report.check("question-survives-owner-drop", {
				expected: { resolvedBroadcasts: 0 },
				actual: { resolvedBroadcasts: 1, outcome: cancelled.outcome },
				defect: OWNER_DROP_DEFECT,
			});
		} else {
			report.pass("question-survives-owner-drop", { resolvedBroadcasts: 0 });
		}

		c = await connect(sandbox.socketPath, "C", report);
		const openC = await openSession(c, { sessionPath, cwd: sandbox.work });
		report.check("pending-question-hydrates-for-C", {
			expected: 1,
			actual: openC.data.state.pendingQuestions?.length ?? 0,
			defect: OWNER_DROP_DEFECT,
		});

		const markAnswer = c.mark();
		c.write({
			type: "extension_ui_response",
			sessionId,
			id: frame.id,
			answers: { q1: { selected: ["PostgreSQL"] } },
			comment: "answered after the drop",
		});
		const answered = await Promise.race([
			c.waitFor((message) => message.type === "question_resolved" && message.id === frame.id, markAnswer).then(() => true),
			delay(5_000).then(() => false),
		]);
		report.check("C-can-answer-after-drop", {
			expected: { resolved: true },
			actual: { resolved: answered },
			defect: OWNER_DROP_DEFECT,
		});
		if (!answered) {
			const rejected = c.find(
				markAnswer,
				(message) => message.type === "response" && message.command === "extension_ui_response" && message.id === frame.id,
			);
			report.info("late-answer-rejection", { error: rejected?.error });
		}

		await delay(1_000);
		const result = readFixtureLog(sandbox.fixtureLog)
			.filter((entry) => entry.event === "result" && entry.label === "drop1")
			.at(-1);
		report.info("fixture-result-after-drop", {
			status: result?.details?.status,
			textPreview: result?.text?.split("\n")[0],
		});
		return true;
	} catch (error) {
		report.fail("scenario-error", { error: String(error?.stack ?? error) });
		return false;
	} finally {
		await teardown(report, { clients: [a, b, c], host, sandbox, label: "owner-drop" });
	}
}
