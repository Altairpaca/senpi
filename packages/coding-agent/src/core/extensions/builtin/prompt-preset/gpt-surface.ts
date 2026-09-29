import type { PromptSurface } from "../../../dynamic-prompt/build.ts";

export const GPT_HANDOFF_MOMENTS: Record<PromptSurface, string> = {
	terminal:
		"the todo list's creation (in the message that creates it, after the routing line, or the next one), a todo phase change, a blocker or plan change, the final message; the routing line is not one",
	app: "the todo list's creation (in the message that creates it or the next one), a todo phase change, a blocker or plan change, the final message",
};

export const GPT_APP_FEEDBACK =
	"Replies render in an app: tool and hook feedback (comment-checker findings, language-server availability, internal notices) is yours to act on; report it only when it changes what the user gets.";
