import { beforeAll, describe, expect, it, vi } from "vitest";
import type { QuestionRequest, QuestionResponse } from "../../src/core/extensions/types.ts";
import {
	AskUserQuestionComponent,
	type AskUserQuestionOptions,
} from "../../src/modes/interactive/components/ask-user-question.ts";
import { formatCountdownLabel } from "../../src/modes/interactive/components/ask-user-question-state.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const TAB = "\t";
const SPACE = " ";
const CTRL_ENTER = "\x1b[13;5u";

function buildRequest(): QuestionRequest {
	return {
		requestId: "req-1",
		questions: [
			{
				id: "auth",
				header: "Auth",
				question: "Which auth method should the CLI use?",
				options: [
					{ label: "OAuth", description: "Token-based login that works with SSO" },
					{ label: "API key", description: "Paste a static key" },
				],
				multiSelect: false,
			},
			{
				id: "extras",
				header: "Extras",
				question: "Which extras should be enabled?",
				options: [
					{ label: "Verbose logging", description: "Log every request" },
					{ label: "Dry run", description: "Do not touch the disk" },
				],
				multiSelect: true,
			},
		],
		waitForAnswer: true,
		timeoutMs: 30 * 60_000,
	};
}

type Harness = {
	component: AskUserQuestionComponent;
	done: (response: QuestionResponse) => void;
	progress: (draft: { answers?: QuestionResponse["answers"]; comment?: string }) => void;
	doneCalls: QuestionResponse[];
	progressCalls: Array<{ answers?: QuestionResponse["answers"]; comment?: string }>;
	render: () => string;
};

function mount(request: QuestionRequest = buildRequest(), opts: AskUserQuestionOptions = {}): Harness {
	const doneCalls: QuestionResponse[] = [];
	const progressCalls: Harness["progressCalls"] = [];
	const component = new AskUserQuestionComponent(
		request,
		(response) => doneCalls.push(response),
		{ ...opts, onProgress: (draft) => progressCalls.push(draft) },
	);
	return {
		component,
		done: () => undefined,
		progress: () => undefined,
		doneCalls,
		progressCalls,
		render: () => stripAnsi(component.render(100).join("\n")),
	};
}

describe("AskUserQuestionComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders tabs, numbered options, own-answer row, comment editor and submit footer", () => {
		const h = mount();
		const output = h.render();

		expect(output).toContain("Auth");
		expect(output).toContain("Extras");
		expect(output).toContain("Which auth method should the CLI use?");
		expect(output).toContain("1. OAuth");
		expect(output).toContain("Token-based login that works with SSO");
		expect(output).toContain("2. API key");
		expect(output).toContain("Type your own answer...");
		expect(output).toContain("Comment (sent as your reply; other questions stay unanswered)");
		expect(output).toContain("Submit (0/2 answered)");
	});

	it("selects an option by digit without auto-submitting", () => {
		const h = mount();

		h.component.handleInput("1");

		expect(h.doneCalls).toHaveLength(0);
		expect(h.progressCalls.length).toBeGreaterThanOrEqual(1);
		const last = h.progressCalls[h.progressCalls.length - 1];
		expect(last?.answers?.auth).toEqual({ selected: ["OAuth"] });
	});

	it("toggles multi-select options with space", () => {
		const h = mount();

		h.component.handleInput(TAB);
		h.component.handleInput(SPACE);
		h.component.handleInput(DOWN);
		h.component.handleInput(SPACE);

		expect(h.doneCalls).toHaveLength(0);
		const last = h.progressCalls[h.progressCalls.length - 1];
		expect(last?.answers?.extras?.selected).toEqual(["Verbose logging", "Dry run"]);

		h.component.handleInput(UP);
		h.component.handleInput(SPACE);
		const afterToggleOff = h.progressCalls[h.progressCalls.length - 1];
		expect(afterToggleOff?.answers?.extras?.selected).toEqual(["Dry run"]);
	});

	it("submits a comment with Enter in the comment editor keeping unanswered ids", () => {
		const h = mount();

		h.component.handleInput("1");
		h.component.handleInput("c");
		h.component.handleInput("just ship it");
		h.component.handleInput(ENTER);

		expect(h.doneCalls).toHaveLength(1);
		const response = h.doneCalls[0];
		expect(response?.status).toBe("comment-submitted");
		expect(response?.comment).toBe("just ship it");
		expect(response?.answers.auth).toEqual({ selected: ["OAuth"] });
		expect(response?.unanswered).toEqual(["extras"]);
	});

	it("cancels on Esc from the options view", () => {
		const h = mount();

		h.component.handleInput(ESC);

		expect(h.doneCalls).toHaveLength(1);
		expect(h.doneCalls[0]?.status).toBe("cancelled");
	});

	it("does not auto-submit after a single select", () => {
		const h = mount();

		h.component.handleInput("2");

		expect(h.doneCalls).toHaveLength(0);
		expect(h.render()).toContain("Submit (0/2 answered)");
	});

	it("submits answered status via ctrl+enter once every question is answered", () => {
		const h = mount();

		h.component.handleInput("1");
		h.component.handleInput(TAB);
		h.component.handleInput("1");
		h.component.handleInput(CTRL_ENTER);

		expect(h.doneCalls).toHaveLength(1);
		const response = h.doneCalls[0];
		expect(response?.status).toBe("answered");
		expect(response?.unanswered).toEqual([]);
		expect(response?.answers.extras).toEqual({ selected: ["Verbose logging"] });
	});

	it("shows the not-answered notice and stays open on an empty partial submit", () => {
		const h = mount();

		h.component.handleInput(CTRL_ENTER);

		expect(h.doneCalls).toHaveLength(0);
		expect(h.render()).toContain("You have not answered all questions");
	});

	it("commits a typed own answer for the active question", () => {
		const h = mount();

		// Move to the own-answer row (two options above it) and open the editor.
		h.component.handleInput(DOWN);
		h.component.handleInput(DOWN);
		h.component.handleInput(ENTER);
		h.component.handleInput("use a vault token");
		h.component.handleInput(ENTER);

		const last = h.progressCalls[h.progressCalls.length - 1];
		expect(last?.answers?.auth).toEqual({ selected: [], text: "use a vault token" });
		expect(h.render()).toContain("use a vault token");
	});

	it("formats the countdown as minutes above five minutes and mm:ss below", () => {
		expect(formatCountdownLabel(30 * 60_000)).toBe("30m");
		expect(formatCountdownLabel(5 * 60_000)).toBe("5m");
		expect(formatCountdownLabel(4 * 60_000 + 59_000)).toBe("04:59");
		expect(formatCountdownLabel(59_000)).toBe("00:59");
	});

	it("ticks the countdown chip to mm:ss under five minutes", () => {
		vi.useFakeTimers();
		try {
			const h = mount(buildRequest(), { timeoutMs: 5 * 60_000 });

			expect(h.render()).toContain("5m");
			vi.advanceTimersByTime(1_000);

			expect(h.render()).toContain("04:59");
		} finally {
			vi.useRealTimers();
		}
	});

	it("resolves timed_out when the countdown expires", () => {
		vi.useFakeTimers();
		try {
			const h = mount(buildRequest(), { timeoutMs: 60_000 });

			h.component.handleInput("1");
			vi.advanceTimersByTime(60_000);

			expect(h.doneCalls).toHaveLength(1);
			const response = h.doneCalls[0];
			expect(response?.status).toBe("timed_out");
			expect(response?.answers.auth).toEqual({ selected: ["OAuth"] });
			expect(response?.unanswered).toEqual(["extras"]);
		} finally {
			vi.useRealTimers();
		}
	});
});
