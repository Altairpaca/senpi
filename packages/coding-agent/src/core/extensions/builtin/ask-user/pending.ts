// TODO(t1-merge): import from ./schema.ts
export type QuestionOption = {
	label: string;
	description?: string;
};

export type QuestionItem = {
	id: string;
	header: string;
	question: string;
	options: QuestionOption[];
	multiSelect: boolean;
};

export type QuestionRequest = {
	requestId: string;
	questions: QuestionItem[];
	waitForAnswer: boolean;
	timeoutMs: number;
};

export type QuestionAnswer = {
	selected: string[];
	text?: string;
};

export type QuestionAnswers = Record<string, QuestionAnswer>;

export type QuestionResponseStatus =
	| "answered"
	| "comment-submitted"
	| "timed_out"
	| "cancelled"
	| "orphaned-after-restart"
	| "unavailable";

export type QuestionResponse = {
	status: QuestionResponseStatus;
	answers: QuestionAnswers;
	comment?: string;
	unanswered: string[];
	autoResolvedAfterMs?: number;
};

export type QuestionDraft = {
	answers: QuestionAnswers;
	comment?: string;
};

export type CancelReason = "cancelled" | "orphaned-after-restart" | "unavailable";

const DEFAULT_HARD_CAP_MS = 7_200_000;

export type PendingTimerHandle = ReturnType<typeof setTimeout>;

export type PendingQuestionOptions = {
	request: QuestionRequest;
	now: () => number;
	idleTimeoutMs: number;
	hardCapMs?: number;
	onTimeout?: (result: QuestionResponse) => void;
	setTimeout?: (handler: () => void, delayMs: number) => PendingTimerHandle;
	clearTimeout?: (handle: PendingTimerHandle) => void;
};

export type PendingQuestionState = "pending" | QuestionResponseStatus;

export type PendingQuestion = {
	touch(draft?: QuestionDraft): void;
	submit(answers: QuestionAnswers, comment?: string): QuestionResponse | false;
	cancel(reason?: CancelReason): QuestionResponse;
	timeout(): QuestionResponse;
	readonly state: PendingQuestionState;
	readonly deadlineAtMs: number;
	remainingMs(now: number): number;
	readonly result: QuestionResponse | undefined;
};

export function createPendingQuestion(_options: PendingQuestionOptions): PendingQuestion {
	throw new Error("not implemented");
}
