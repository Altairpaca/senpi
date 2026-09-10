/**
 * Key dispatch for the ask-user question overlay. Split from the component to
 * keep every sibling under 250 LOC; handlers operate on the shared state and
 * the component's Inputs via an explicit context.
 */

import { getKeybindings, type Input, matchesKey } from "@earendil-works/pi-tui";
import type { QuestionResponse } from "../../../core/extensions/types.ts";
import type { AskUserQuestionState } from "./ask-user-question-state.ts";

export interface AskUserKeyHandlerContext {
	state: AskUserQuestionState;
	ownAnswerInput: Input;
	commentInput: Input;
	finish(status: QuestionResponse["status"], autoResolvedAfterMs?: number): void;
	attemptSubmit(): void;
	openOwnAnswer(): void;
	commitOwnAnswer(): void;
	emitProgress(): void;
	updateAll(): void;
}

export function handleAskUserKeyInput(ctx: AskUserKeyHandlerContext, data: string): void {
	const kb = getKeybindings();
	if (ctx.state.focus === "own-answer") {
		handleOwnAnswerKey(ctx, data, kb);
		return;
	}
	if (ctx.state.focus === "comment") {
		handleCommentKey(ctx, data, kb);
		return;
	}
	handleOptionsKey(ctx, data, kb);
}

function handleOwnAnswerKey(ctx: AskUserKeyHandlerContext, data: string, kb: ReturnType<typeof getKeybindings>): void {
	if (matchesKey(data, "ctrl+enter")) {
		ctx.commitOwnAnswer();
		ctx.attemptSubmit();
		return;
	}
	if (kb.matches(data, "tui.select.confirm") || data === "\n") {
		ctx.commitOwnAnswer();
		return;
	}
	if (kb.matches(data, "tui.select.cancel")) {
		ctx.state.focus = "options";
		ctx.updateAll();
		return;
	}
	ctx.ownAnswerInput.handleInput(data);
	ctx.emitProgress();
}

function handleCommentKey(ctx: AskUserKeyHandlerContext, data: string, kb: ReturnType<typeof getKeybindings>): void {
	if (matchesKey(data, "ctrl+enter") || kb.matches(data, "tui.input.submit") || data === "\n") {
		ctx.attemptSubmit();
		return;
	}
	if (kb.matches(data, "tui.select.cancel")) {
		ctx.state.focus = "options";
		ctx.updateAll();
		return;
	}
	ctx.commentInput.handleInput(data);
	ctx.state.comment = ctx.commentInput.getValue();
	ctx.emitProgress();
}

function handleOptionsKey(ctx: AskUserKeyHandlerContext, data: string, kb: ReturnType<typeof getKeybindings>): void {
	const state = ctx.state;
	if (matchesKey(data, "ctrl+enter")) {
		ctx.attemptSubmit();
		return;
	}
	if (kb.matches(data, "tui.select.cancel")) {
		ctx.finish("cancelled");
		return;
	}
	if (matchesKey(data, "tab") || matchesKey(data, "right")) {
		state.switchQuestion(1);
		ctx.updateAll();
		return;
	}
	if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) {
		state.switchQuestion(-1);
		ctx.updateAll();
		return;
	}
	if (kb.matches(data, "tui.select.up") || data === "k") {
		state.highlightIndex = Math.max(0, state.highlightIndex - 1);
		ctx.updateAll();
		return;
	}
	if (kb.matches(data, "tui.select.down") || data === "j") {
		if (state.highlightIndex >= state.ownAnswerRowIndex) state.focus = "comment";
		else state.highlightIndex += 1;
		ctx.updateAll();
		return;
	}
	if (data.length === 1 && data >= "1" && data <= "9") {
		const option = state.activeQuestion.options[Number(data) - 1];
		if (option) {
			state.activateOption(state.activeQuestion.id, option.label);
			ctx.emitProgress();
			ctx.updateAll();
		}
		return;
	}
	if (matchesKey(data, "space") || kb.matches(data, "tui.select.confirm") || data === "\n") {
		activateHighlighted(ctx);
		return;
	}
	if (data === "c") {
		state.focus = "comment";
		ctx.updateAll();
	}
}

function activateHighlighted(ctx: AskUserKeyHandlerContext): void {
	const state = ctx.state;
	if (state.highlightIndex === state.ownAnswerRowIndex) {
		ctx.openOwnAnswer();
		return;
	}
	const option = state.activeQuestion.options[state.highlightIndex];
	if (!option) return;
	state.activateOption(state.activeQuestion.id, option.label);
	ctx.emitProgress();
	ctx.updateAll();
}
