import type { KernelToHostMessage } from "../../bridge/protocol.ts";
import { abandonedWorkerNote, type JavaScriptInterruptBounds, type WorkerRetirement } from "./interrupt-bounds.ts";
import { type PendingJavaScriptRun, stoppedResult } from "./run-queue.ts";

const SHELL_RESTART_NOTICE =
	"JavaScript kernel restarted while waiting on Bun.$; its variables were cleared.\nUse Bun.spawn or the bash tool for commands you may want to stop.";

export function restartedResult(
	run: PendingJavaScriptRun,
	message: string,
): Extract<KernelToHostMessage, { type: "result" }> {
	const result = run.interruptResult ?? stoppedResult(run.input.cellId, message);
	if (!run.shellWaitActive || result.ok) return result;
	return {
		...result,
		error: {
			...result.error,
			code: "js_shell_interrupt_restart",
			message: `${result.error.message}\n${SHELL_RESTART_NOTICE}`,
		},
	};
}

export function restartOutcome(
	run: PendingJavaScriptRun,
	retirement: WorkerRetirement,
	bounds: JavaScriptInterruptBounds,
): { readonly retained: false; readonly note?: string } {
	const notes = [
		...(run.shellWaitActive ? [SHELL_RESTART_NOTICE] : []),
		...(retirement === "abandoned" ? [abandonedWorkerNote(bounds.terminateDeadlineMs)] : []),
	];
	return { retained: false, ...(notes.length === 0 ? {} : { note: notes.join("\n") }) };
}
