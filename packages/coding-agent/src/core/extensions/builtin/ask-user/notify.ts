import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import type { AskUserVariant, QuestionRequest, QuestionResponse } from "./schema.ts";

export const ASK_USER_SETTLED_EVENT = "ask-user:settled";
export const ASK_USER_ASKED_EVENT = "ask-user:asked";

export type AskUserAskedEvent = {
	readonly ctx: ExtensionContext;
	readonly request: QuestionRequest;
	readonly variant: AskUserVariant;
};

export type AskUserSettledEvent = {
	readonly ctx: ExtensionContext;
	readonly request: QuestionRequest;
	readonly response: QuestionResponse;
	readonly variant: AskUserVariant;
};

/** Publish only; the active hooks builtin owns preparation and command execution. */
export function emitAskUserNotification(
	pi: Pick<ExtensionAPI, "events">,
	ctx: ExtensionContext,
	request: QuestionRequest,
	response: QuestionResponse,
	variant: AskUserVariant,
): void {
	if (response.status === "cancelled") return;
	pi.events.emit(ASK_USER_SETTLED_EVENT, { ctx, request, response, variant } satisfies AskUserSettledEvent);
}
