import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { pickVariant, TOOL_NAMES } from "./family.ts";
import { getPendingQuestions } from "./registry.ts";
import { type AskUserState, createAskUserTool } from "./tool.ts";

export default function askUserExtension(pi: ExtensionAPI): void {
	const state: AskUserState = { timedOut: false, unavailable: false };
	let registered = false;
	const cancelPending = (ctx: ExtensionContext, message: string) => {
		for (const entry of getPendingQuestions(ctx.sessionManager.getSessionId())) entry.cancel(message);
	};
	const sync = (ctx: ExtensionContext, model = ctx.model) => {
		const rest = pi.getActiveTools().filter((name) => !Object.values(TOOL_NAMES).includes(name));
		if (ctx.getAskUserSettings?.().enabled === false || pi.getFlag("no-ask-user") === true) {
			cancelPending(ctx, "The pending question was cancelled because ask-user is disabled.");
			pi.setActiveTools(rest);
			return;
		}
		if (!registered) {
			pi.registerTool(createAskUserTool("codex", pi, state));
			pi.registerTool(createAskUserTool("claude", pi, state));
			registered = true;
		}
		pi.setActiveTools(state.unavailable ? rest : [...rest, TOOL_NAMES[pickVariant(model)]]);
	};
	pi.on("session_start", async (_event, ctx) => {
		state.timedOut = false;
		state.unavailable = false;
		sync(ctx);
	});
	pi.on("model_select", async (event, ctx) => {
		sync(ctx, event.model);
	});
	pi.on("agent_end", async () => {
		state.timedOut = false;
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		cancelPending(ctx, "The pending question was cancelled because the session closed.");
	});
}
