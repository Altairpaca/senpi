/**
 * Continue a session from its current leaf with no new prompt (senpi #1930).
 *
 * A request may not end with an assistant message on the default models
 * (Claude 4.6+ rejects assistant prefill, OpenAI's Responses API has none), so
 * the continuation is a hidden custom message (display false) that drives the
 * next turn, the same mechanism as the "." manual-continue shortcut. It has its
 * own type so extensions that react to a manual continue (a blocked goal
 * resuming) do not mistake it for one.
 */

export const CONTINUE_FROM_LEAF_CUSTOM_TYPE = "continue-from-leaf";

export const CONTINUE_FROM_LEAF_DIRECTIVE = `<system-notice>
Continue from where the conversation ends.

Your last reply may have been edited by the user; treat its current text as your own words.
Carry on from it without repeating it, apologizing for it, or commenting on the edit.
</system-notice>`;

export type ContinueFromLeafCode = "streaming" | "nothing_to_continue";

export class ContinueFromLeafError extends Error {
	readonly code: ContinueFromLeafCode;

	constructor(code: ContinueFromLeafCode) {
		super(
			code === "streaming"
				? "Wait for the current response to finish before continuing."
				: "There is nothing to continue: the session has no messages yet.",
		);
		this.name = "ContinueFromLeafError";
		this.code = code;
	}
}
