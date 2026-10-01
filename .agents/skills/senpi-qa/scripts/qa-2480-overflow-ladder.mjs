#!/usr/bin/env node
/**
 * senpi#2480 through the real CLI: a provider that counts the request denser than
 * senpi's estimate rejects the turn as "prompt is too long", and the compacted
 * re-send that keeps the configured tail is still too long. The overflow ladder
 * must climb to its second rung (summary plus the turn being answered) inside the
 * same turn and answer, instead of ending after one compact-and-retry.
 *
 * The fake provider is content-aware: compaction's summarization requests
 * (recognized by their internal instruction) are always answered; every agent
 * turn is counted as
 * `bytes(conversation messages) * factor` and rejected when that exceeds the
 * window. The system message is left out of the count so the scenario does not
 * depend on the size of senpi's own system prompt.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { cleanupAll, evidenceDir, installCleanupHooks, makeSandbox, realAuthPath, runCli, stripAnsi } from "./lib/common.mjs";
import { hermeticEnv, writeMockModelsJson } from "./lib/mock-loop-support.mjs";

const WINDOW = 200_000;
const CHUNK = "earlier work on the long task ".repeat(1_334); // ~40 KB, ~10k tokens by senpi's estimate
const RECOVERED = "SENPI-QA-2480-RECOVERED";
// Compaction's summarization requests reuse the agent's system prompt and tools (prompt-cache
// reuse) and append one of these internal instructions; core's fallback prompt is the last one.
const SUMMARY_SIGNATURES = ["INSTRUCTION — NOT CONVERSATION HISTORY]", "You are a context summarization assistant."];

const results = [];
function check(label, passed, detail) {
	results.push({ label, passed, detail });
	console.log(`${passed ? "PASS" : "FAIL"} ${label}${detail ? ` - ${detail}` : ""}`);
}

function authFingerprint() {
	const path = realAuthPath();
	return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "absent";
}

function startCountingProvider() {
	const state = { factor: 1, log: [] };
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			const request = JSON.parse(body || "{}");
			const messages = request.messages ?? [];
			const raw = JSON.stringify(messages);
			const summarization = SUMMARY_SIGNATURES.some((signature) => raw.includes(signature));
			const conversation = messages.filter((message) => message.role !== "system" && message.role !== "developer");
			const counted = Buffer.byteLength(JSON.stringify(conversation), "utf8") * state.factor;
			const turns = conversation.length;
			if (!summarization && counted > WINDOW) {
				state.log.push({ kind: "rejected", counted, turns });
				res.writeHead(400, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "prompt is too long", type: "invalid_request_error" } }));
				return;
			}
			const text = summarization ? "## Goal\nsummary of the earlier work" : `${RECOVERED} answer ${state.log.length}`;
			state.log.push({ kind: summarization ? "summary" : "answered", counted, turns });
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			const base = { id: "chatcmpl-qa2480", object: "chat.completion.chunk", created: 0, model: "mock-model" };
			const send = (delta, finish = null) =>
				res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
			send({ role: "assistant", content: text });
			send({}, "stop");
			res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			const origin = `http://127.0.0.1:${port}`;
			resolve({ state, origin, url: `${origin}/v1`, stop: () => new Promise((done) => server.close(() => done())) });
		});
	});
}

async function main() {
	installCleanupHooks();
	const authBefore = authFingerprint();
	const box = makeSandbox("senpi-qa-2480");
	const env = hermeticEnv(box.env);
	const provider = await startCountingProvider();
	const cli = ["--print", "--provider", "mock", "--model", "mock-model"];
	let transcript = "";
	try {
		writeMockModelsJson(box.agentDir, provider, "openai-completions", { contextWindow: WINDOW, maxTokens: 4_096 });

		for (let turn = 1; turn <= 3; turn += 1) {
			const run = await runCli([...cli, ...(turn > 1 ? ["--continue"] : []), `${CHUNK} (turn ${turn})`], {
				env,
				cwd: box.cwd,
				timeoutMs: 120_000,
			});
			check(`history turn ${turn} completes`, run.code === 0 && stripAnsi(run.stdout).includes(RECOVERED), `exit ${run.code}`);
		}

		// From here the provider counts three times denser: the full history and the
		// configured ~20k-token tail both overflow; the summary plus this turn fits.
		provider.state.factor = 3;
		const before = provider.state.log.length;
		const run = await runCli([...cli, "--continue", "continue the task"], { env, cwd: box.cwd, timeoutMs: 180_000 });
		const out = stripAnsi(run.stdout);
		const err = stripAnsi(run.stderr);
		const turnLog = provider.state.log.slice(before);
		const answers = turnLog.filter((entry) => entry.kind !== "summary");
		check("overflowing turn answers inside the same turn", run.code === 0 && out.includes(RECOVERED), `exit ${run.code}`);
		check(
			"two re-sends were rejected before the answer (full history, then the configured tail)",
			answers.length === 3 && answers[0].kind === "rejected" && answers[1].kind === "rejected" && answers[2].kind === "answered",
			JSON.stringify(answers),
		);
		check("each rejection was followed by a compaction", turnLog.filter((entry) => entry.kind === "summary").length >= 2, "");
		check("no exhaustion notice", !/recovery failed after/i.test(out + err), "");
		transcript = [`provider log for the overflowing turn: ${JSON.stringify(turnLog)}`, "", "stdout:", out.trim(), "", "stderr:", err.trim()].join("\n");
	} finally {
		await provider.stop();
		box.cleanup();
		cleanupAll();
	}
	check("real auth file untouched", authFingerprint() === authBefore, "");

	const dir = evidenceDir("issue2480-overflow-ladder");
	writeFileSync(
		join(dir, "qa-2480-overflow-ladder.log"),
		[
			"# senpi-qa: #2480 overflow ladder through the real CLI",
			`# date: ${new Date().toISOString()}`,
			"",
			...results.map((entry) => `${entry.passed ? "PASS" : "FAIL"} ${entry.label}${entry.detail ? ` - ${entry.detail}` : ""}`),
			"",
			transcript,
			"",
			"cleanup: fake provider closed; sandbox removed; no tracked child left running",
		].join("\n"),
	);
	console.log(`evidence: ${join(dir, "qa-2480-overflow-ladder.log")}`);
	const failed = results.filter((entry) => !entry.passed);
	if (failed.length > 0) {
		console.error(`${failed.length} check(s) failed`);
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	cleanupAll();
	process.exit(1);
});
