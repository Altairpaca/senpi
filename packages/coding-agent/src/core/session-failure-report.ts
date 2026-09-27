import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "./session-manager.ts";

/**
 * Prompts below this size cannot be prefix-cached by the major providers, so a
 * zero cache read on them is not evidence of a lost cache.
 */
export const MIN_CACHEABLE_PROMPT_TOKENS = 2048;

/** What provider failures cost a session: every provider response is one request. */
export interface SessionFailureReport {
	requests: number;
	erroredRequests: number;
	abortedRequests: number;
	failureShare: number;
	/** Wall time from each failed request's start to its recorded end. */
	failedDurationMs: number;
	/** First successful responses after one or more failed requests. */
	postFailureRequests: number;
	/** Post-failure responses that read nothing from the prompt cache on a cacheable prompt. */
	postFailureFullMissRequests: number;
	/** Uncached prompt tokens (input + cache writes) those full misses re-sent. */
	postFailureFullMissInputTokens: number;
}

function isAssistantEntry(entry: SessionEntry): entry is SessionEntry & { message: AssistantMessage } {
	return entry.type === "message" && entry.message.role === "assistant";
}

function requestDurationMs(recordedAt: string, startedAt: number): number {
	const endedAt = Date.parse(recordedAt);
	return Number.isFinite(endedAt) && Number.isFinite(startedAt) && endedAt > startedAt ? endedAt - startedAt : 0;
}

export function computeSessionFailureReport(entries: readonly SessionEntry[]): SessionFailureReport {
	let requests = 0;
	let erroredRequests = 0;
	let abortedRequests = 0;
	let failedDurationMs = 0;
	let postFailureRequests = 0;
	let postFailureFullMissRequests = 0;
	let postFailureFullMissInputTokens = 0;
	let previousFailed = false;
	for (const entry of entries) {
		if (!isAssistantEntry(entry)) continue;
		const { message } = entry;
		requests++;
		const failed = message.stopReason === "error" || message.stopReason === "aborted";
		if (failed) {
			if (message.stopReason === "error") erroredRequests++;
			else abortedRequests++;
			failedDurationMs += requestDurationMs(entry.timestamp, message.timestamp);
		} else if (previousFailed) {
			postFailureRequests++;
			const uncachedTokens = message.usage.input + message.usage.cacheWrite;
			if (message.usage.cacheRead === 0 && uncachedTokens >= MIN_CACHEABLE_PROMPT_TOKENS) {
				postFailureFullMissRequests++;
				postFailureFullMissInputTokens += uncachedTokens;
			}
		}
		previousFailed = failed;
	}
	return {
		requests,
		erroredRequests,
		abortedRequests,
		failureShare: requests > 0 ? (erroredRequests + abortedRequests) / requests : 0,
		failedDurationMs,
		postFailureRequests,
		postFailureFullMissRequests,
		postFailureFullMissInputTokens,
	};
}
