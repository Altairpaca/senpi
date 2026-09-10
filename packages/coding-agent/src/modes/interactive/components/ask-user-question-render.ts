/**
 * Line builders for the ask-user question overlay. Kept separate from the
 * component so the layout rules stay under the 250-LOC sibling limit; the
 * component owns focus, key decoding and the inline Inputs.
 */

import type { QuestionRequest } from "../../../core/extensions/types.ts";
import { theme } from "../theme/theme.ts";
import { type AskUserQuestionState, COMMENT_LABEL, OWN_ANSWER_LABEL } from "./ask-user-question-state.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export function renderTitle(countdownLabel: string): string {
	const suffix = countdownLabel === "" ? "" : theme.fg("muted", ` · ${countdownLabel}`);
	return theme.fg("accent", theme.bold("Ask user")) + suffix;
}

export function renderTabBar(state: AskUserQuestionState): string {
	const tabs = state.request.questions.map((question, index) => {
		const answered = state.isAnswered(question.id) ? theme.fg("success", " ✓") : "";
		const label = `${question.header}${answered}`;
		return index === state.activeIndex
			? theme.fg("accent", theme.bold(`→ ${label}`))
			: theme.fg("muted", `  ${label}`);
	});
	return tabs.join("  ");
}

export function renderQuestionLine(question: QuestionRequest["questions"][number]): string {
	return theme.fg("text", question.question);
}

export function renderQuestionList(state: AskUserQuestionState): string[] {
	const lines: string[] = [];
	const active = state.activeQuestion;
	active.options.forEach((option, index) => {
		const highlighted = index === state.highlightIndex && state.focus === "options";
		const marker = state.isSelected(active.id, option.label) ? theme.fg("success", " ✓") : "";
		const prefix = highlighted ? theme.fg("accent", "→ ") : "  ";
		lines.push(`${prefix}${index + 1}. ${theme.fg("text", option.label)}${marker}`);
		if (option.description) {
			lines.push(theme.fg("muted", `     ${option.description}`));
		}
	});
	const ownText = state.textFor(active.id);
	const ownSuffix = ownText !== undefined ? theme.fg("text", `: ${ownText}`) : "";
	const ownHighlighted = state.highlightIndex === state.ownAnswerRowIndex && state.focus === "options";
	const ownPrefix = ownHighlighted ? theme.fg("accent", "→ ") : "  ";
	lines.push(`${ownPrefix}${theme.fg("muted", OWN_ANSWER_LABEL)}${ownSuffix}`);
	return lines;
}

export function renderOwnAnswerLabel(): string {
	return theme.fg("muted", "Your answer (enter to save, esc to discard)");
}

export function renderCommentLabel(): string {
	return theme.fg("muted", COMMENT_LABEL);
}

export function renderNotice(notice: string | undefined): string {
	return notice === undefined ? "" : theme.fg("warning", `! ${notice}`);
}

export function renderSubmitLine(state: AskUserQuestionState): string {
	const answered = state.answeredCount();
	const total = state.request.questions.length;
	return (
		theme.fg("accent", theme.bold(`Submit (${answered}/${total} answered)`)) +
		theme.fg("muted", " — ctrl+enter or enter in comment")
	);
}

export function renderHintsLine(): string {
	return (
		rawKeyHint("↑↓", "move") +
		"  " +
		rawKeyHint("1-9", "select") +
		"  " +
		rawKeyHint("space", "toggle") +
		"  " +
		keyHint("tui.select.confirm", "select") +
		"  " +
		rawKeyHint("tab", "next question") +
		"  " +
		rawKeyHint("c", "comment") +
		"  " +
		keyHint("tui.select.cancel", "cancel")
	);
}
