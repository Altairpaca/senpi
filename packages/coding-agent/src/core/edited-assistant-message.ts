import type { AssistantMessage } from "@earendil-works/pi-ai";
import { contentText } from "@earendil-works/pi-ai";

export class AssistantEditError extends Error {
	readonly reason: "empty" | "not-assistant" | "not-found";

	constructor(reason: AssistantEditError["reason"], message: string) {
		super(message);
		this.name = "AssistantEditError";
		this.reason = reason;
	}
}

export function assistantTextEquals(original: AssistantMessage, text: string): boolean {
	return contentText(original.content, "").trim() === text.trim();
}

/**
 * Text replaces every content block: thinking signatures and tool calls belong to the abandoned
 * response, and a leaf ending in tool calls without results is rejected by providers.
 * Model identity and usage stay so per-path cost and context estimates remain accurate.
 */
export function buildEditedAssistantMessage(original: AssistantMessage, text: string): AssistantMessage {
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		throw new AssistantEditError("empty", "Edited assistant response cannot be empty");
	}
	return {
		role: "assistant",
		content: [{ type: "text", text: trimmed }],
		api: original.api,
		provider: original.provider,
		model: original.model,
		...(original.responseModel !== undefined ? { responseModel: original.responseModel } : {}),
		usage: original.usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}
