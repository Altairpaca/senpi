import type { AskUserVariant, QuestionRequest, QuestionResponse } from "./schema.ts";

export type CodexResultDetails = {
	answers: Record<string, { answers: string[] }>;
	comment?: string;
	unanswered: string[];
	status: QuestionResponse["status"];
};

export type ClaudeResultDetails = {
	questions: QuestionRequest["questions"];
	answers: Record<string, string>;
	freeText?: string;
	unanswered: string[];
	status: QuestionResponse["status"];
};

export function formatResultText(
	_variant: AskUserVariant,
	_response: QuestionResponse,
	_questions: QuestionRequest["questions"] = [],
): string {
	return "";
}

export function formatUserMessage(
	_response: QuestionResponse,
	_requestId: string,
	_questions: QuestionRequest["questions"] = [],
): string {
	return "";
}

export function formatResultDetails(
	variant: AskUserVariant,
	response: QuestionResponse,
	_questions: QuestionRequest["questions"] = [],
): CodexResultDetails | ClaudeResultDetails {
	if (variant === "codex") {
		return { answers: {}, unanswered: response.unanswered, status: response.status };
	}
	return { questions: [], answers: {}, unanswered: response.unanswered, status: response.status };
}
