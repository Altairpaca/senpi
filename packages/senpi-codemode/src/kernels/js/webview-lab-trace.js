import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { threadId } from "node:worker_threads";

// LAB INSTRUMENTATION (senpi#2353): same sink as coding-agent's webview-trace.ts; removed before merge.
const TRACE_DIR = process.env.SENPI_WEBVIEW_TRACE_DIR;
if (TRACE_DIR) mkdirSync(TRACE_DIR, { recursive: true });

export function labTrace(phase, detail = "") {
	if (!TRACE_DIR) return;
	const line = `${new Date().toISOString()} pid=${process.pid} tid=${threadId} ${phase}${detail ? ` ${detail}` : ""}\n`;
	appendFileSync(join(TRACE_DIR, `${process.pid}.log`), line);
}
