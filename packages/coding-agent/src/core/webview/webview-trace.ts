import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { isMainThread, threadId } from "node:worker_threads";

// LAB INSTRUMENTATION (senpi#2353): named launch phases, written synchronously so a hang still leaves them.
const TRACE_DIR = process.env.SENPI_WEBVIEW_TRACE_DIR;
if (TRACE_DIR) mkdirSync(TRACE_DIR, { recursive: true });

export function webviewTrace(phase: string, detail = ""): void {
	if (!TRACE_DIR) return;
	const line = `${new Date().toISOString()} pid=${process.pid} tid=${threadId} ${phase}${detail ? ` ${detail}` : ""}\n`;
	appendFileSync(join(TRACE_DIR, `${process.pid}.log`), line);
}

let sampling = false;

/** Logs every main-thread turn that arrives more than a second late: a blocked loop, not a slow promise. */
export function startMainThreadLagSampler(): void {
	if (!TRACE_DIR || !isMainThread || sampling) return;
	sampling = true;
	let last = performance.now();
	const timer = setInterval(() => {
		const now = performance.now();
		const lag = now - last - 250;
		if (lag > 1_000) webviewTrace("main-thread.lag", `ms=${Math.round(lag)}`);
		last = now;
	}, 250);
	timer.unref();
}
