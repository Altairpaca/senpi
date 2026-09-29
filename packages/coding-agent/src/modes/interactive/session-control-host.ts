/**
 * What the interactive mode installs on its session so an extension can register a control
 * endpoint. It is the only piece loaded at startup: the endpoint itself is imported on the first
 * registration (a plain TUI never loads it), and it holds at most one endpoint per process.
 *
 * It also turns editor callbacks into the two editor edges. `draft_cleared` must not fire for a
 * submission, and the editor clears itself (`onChange("")`) synchronously BEFORE it calls
 * `onSubmit`, so the clear is judged one microtask later, after the submission had its chance to
 * claim it.
 *
 * A submission holds admission until the runtime has taken it: plain text only resolves the main
 * loop's pending input, and the loop calls `prompt()` later, so without the hold a delivery could
 * start its own turn ahead of the user's message. The hold ends when the user's turn starts, when
 * the loop's prompt call ends, or - for input that starts no turn here (a command, a steer into a
 * running turn) - once the submit handler settled and no prompt call picked the input up. Its end
 * is the `submission` edge.
 */
import type { RegisterControlEndpointOptions, SessionControlRegistration } from "../../core/extensions/types.ts";
import type { ControlEndpointHost } from "../../core/session-control-actions.ts";
import type { ActiveControlEndpoint, TuiControlContext } from "./session-control-lifecycle.ts";

interface ControlledEditor {
	onChange?: (text: string) => void;
	onSubmit?: (text: string) => void;
}

export class TuiSessionControlHost implements ControlEndpointHost {
	private active: ActiveControlEndpoint | undefined;
	private editorRevision = 0;
	private hadDraft = false;
	private submitting = false;
	private submissionHeld = false;
	private promptsRunning = 0;
	private readonly context: () => Omit<TuiControlContext, "editorRevision">;

	constructor(context: () => Omit<TuiControlContext, "editorRevision">) {
		this.context = context;
	}

	async register(options: RegisterControlEndpointOptions): Promise<SessionControlRegistration> {
		await this.disposeActive();
		const { registerSessionControlEndpoint } = await import("./session-control-endpoint.ts");
		const outcome = await registerSessionControlEndpoint(
			{ ...this.context(), editorRevision: () => this.editorRevision, onTurnStart: () => this.releaseSubmission() },
			options,
		);
		if ("endpoint" in outcome) this.active = outcome.endpoint;
		return outcome.registration;
	}

	/** Wraps the editor's callbacks; call after both are assigned. `hasDraft` reads the composer now. */
	attachEditor(editor: ControlledEditor, hasDraft: () => boolean): void {
		const change = editor.onChange;
		editor.onChange = (text) => {
			change?.(text);
			this.editorChanged(hasDraft());
		};
		const submit = editor.onSubmit;
		editor.onSubmit = (text) => {
			this.submitting = true;
			this.submissionHeld = true;
			queueMicrotask(() => {
				this.submitting = false;
			});
			void Promise.resolve(submit?.(text)).finally(() =>
				setImmediate(() => {
					if (this.promptsRunning === 0 || this.context().session.isStreaming) this.releaseSubmission();
				}),
			);
		};
	}

	submissionInFlight(): boolean {
		return this.submissionHeld;
	}

	/** Brackets the main loop's `prompt()` for a submitted input. */
	async runPrompt<T>(prompt: Promise<T>): Promise<T> {
		this.promptsRunning += 1;
		try {
			return await prompt;
		} finally {
			this.promptsRunning -= 1;
			this.releaseSubmission();
		}
	}

	questionsChanged(): void {
		this.active?.noteQuestions();
	}

	async disposeActive(): Promise<void> {
		const active = this.active;
		this.active = undefined;
		await active?.dispose();
	}

	private releaseSubmission(): void {
		if (!this.submissionHeld) return;
		this.submissionHeld = false;
		this.active?.wake("submission");
	}

	private editorChanged(hasDraft: boolean): void {
		this.editorRevision += 1;
		const cleared = this.hadDraft && !hasDraft;
		this.hadDraft = hasDraft;
		this.active?.noteState();
		if (!cleared) return;
		queueMicrotask(() => {
			if (!this.submitting) this.active?.wake("draft_cleared");
		});
	}
}
