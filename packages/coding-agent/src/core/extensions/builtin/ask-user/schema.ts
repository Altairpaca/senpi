import { Type } from "typebox";

// TODO(t3-merge): re-export from ../../types.ts
export interface QuestionRequest {
	requestId: string;
	questions: Array<{
		id: string;
		header: string;
		question: string;
		options: Array<{ label: string; description?: string }>;
		multiSelect: boolean;
	}>;
	waitForAnswer: boolean;
	timeoutMs: number;
}

// TODO(t3-merge): re-export from ../../types.ts
export interface QuestionResponse {
	status:
		| "answered"
		| "comment-submitted"
		| "timed_out"
		| "cancelled"
		| "orphaned-after-restart"
		| "unavailable";
	answers: Record<string, { selected: string[]; text?: string }>;
	comment?: string;
	unanswered: string[];
	autoResolvedAfterMs?: number;
}

export type AskUserVariant = "codex" | "claude";

export const WAIT_FLAG_STEER_TEXT =
	"This call omitted wait_for_answer (or waitForAnswer). Set true to pause here until the user answers, false to keep working and receive the answer later as a user message.";

export const DEFAULT_ASK_USER_TIMEOUT_MS = 30 * 60 * 1000;

export class AskUserSchemaError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AskUserSchemaError";
	}
}

export const CODEX_PARAMS = Type.Object({
	questions: Type.Array(Type.Object({})),
	wait_for_answer: Type.Optional(Type.Boolean()),
});

export const CLAUDE_PARAMS = Type.Object({
	questions: Type.Array(Type.Object({})),
	waitForAnswer: Type.Optional(Type.Boolean()),
});

export function toCanonical(_variant: AskUserVariant, _args: unknown): QuestionRequest {
	return {
		requestId: "stub",
		questions: [],
		waitForAnswer: true,
		timeoutMs: DEFAULT_ASK_USER_TIMEOUT_MS,
	};
}
