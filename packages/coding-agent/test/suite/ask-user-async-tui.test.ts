import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import askUserExtension from "../../src/core/extensions/builtin/ask-user/index.ts";
import type { ExtensionAPI, ExtensionContext, QuestionRequest } from "../../src/core/extensions/types.ts";
import {
	ASK_USER_ANSWER_KEY,
	ASK_USER_WIDGET_KEY,
} from "../../src/modes/interactive/components/ask-user-async-widget.ts";
import { AskUserQuestionComponent } from "../../src/modes/interactive/components/ask-user-question.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createHarness, type Harness } from "./harness.ts";
import { createFakeInteractiveMode, type FakeInteractiveMode } from "./helpers/ask-user-async-fake-mode.ts";

const ESC = "\x1b";
const CTRL_ENTER = "\x1b[13;5u";
const ALT_A = "\x1ba";

function buildRequest(): QuestionRequest {
	return {
		requestId: "req-1",
		questions: [
			{
				id: "auth",
				header: "Auth",
				question: "Which auth method?",
				options: [
					{ label: "OAuth", description: "Token login" },
					{ label: "API key", description: "Static key" },
				],
				multiSelect: false,
			},
		],
		waitForAnswer: false,
		timeoutMs: 30 * 60_000,
	};
}

function overlay(fake: FakeInteractiveMode): AskUserQuestionComponent | undefined {
	return fake.editorContainer.children.find((child) => child instanceof AskUserQuestionComponent);
}

const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0)) h.cleanup();
	vi.useRealTimers();
});

describe("async ask-user question in the interactive TUI", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("shows the collapsed widget above the editor and no overlay", async () => {
		const fake = createFakeInteractiveMode();
		const pending = fake.createExtensionUIContext().question?.(buildRequest(), { timeout: 30 * 60_000 });
		expect(pending).toBeInstanceOf(Promise);

		expect(fake.widgetText(ASK_USER_WIDGET_KEY)).toContain("Question pending (1 unanswered)");
		expect(fake.widgetText(ASK_USER_WIDGET_KEY)).toContain("just type your reply");
		expect(overlay(fake)).toBeUndefined();
		expect(fake.editorContainer.children).toContain(fake.editor);
		expect(fake.session.sendUserMessage).not.toHaveBeenCalled();
	});

	it("opens the component on the shortcut and delivers one framed message on submit", async () => {
		const fake = createFakeInteractiveMode({ isStreaming: true });
		const pending = fake.createExtensionUIContext().question?.(buildRequest(), { timeout: 30 * 60_000 });
		if (!pending) throw new Error("question() returned nothing");

		expect(fake.pressEditorKey(ALT_A)).toBe(true);
		const component = overlay(fake);
		if (!component) throw new Error("shortcut did not mount the question component");
		expect(fake.ui.setFocus).toHaveBeenLastCalledWith(component);

		component.handleInput("1");
		component.handleInput(CTRL_ENTER);
		const response = await pending;

		expect(response).toMatchObject({ status: "answered", answers: { auth: { selected: ["OAuth"] } } });
		expect(fake.session.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(fake.session.sendUserMessage).toHaveBeenCalledWith("[Answer to question req-1]\nAuth: OAuth", {
			deliverAs: "steer",
		});
		expect(fake.widgetText(ASK_USER_WIDGET_KEY)).toBeUndefined();
		expect(overlay(fake)).toBeUndefined();
		expect(fake.editorContainer.children).toContain(fake.editor);
	});

	it("uses followUp delivery when the agent is idle", async () => {
		const fake = createFakeInteractiveMode({ isStreaming: false });
		const pending = fake.createExtensionUIContext().question?.(buildRequest(), { timeout: 30 * 60_000 });
		if (!pending) throw new Error("question() returned nothing");
		fake.pressEditorKey(ALT_A);
		overlay(fake)?.handleInput("1");
		overlay(fake)?.handleInput(CTRL_ENTER);
		await pending;
		expect(fake.session.sendUserMessage).toHaveBeenCalledWith(expect.any(String), { deliverAs: "followUp" });
	});

	it("turns ordinary editor text into the comment answer exactly once", async () => {
		const fake = createFakeInteractiveMode({ isStreaming: true });
		const pending = fake.createExtensionUIContext().question?.(buildRequest(), { timeout: 30 * 60_000 });
		if (!pending) throw new Error("question() returned nothing");

		await fake.submitEditorText("just use bun");
		const response = await pending;

		expect(response).toMatchObject({ status: "comment-submitted", comment: "just use bun", unanswered: ["auth"] });
		expect(fake.session.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(fake.session.sendUserMessage).toHaveBeenCalledWith(
			"[Answer to question req-1]\nThe user responded: just use bun\nUnanswered: Auth",
			{ deliverAs: "steer" },
		);
		expect(fake.session.prompt).not.toHaveBeenCalled();
		expect(fake.onInputCallback).not.toHaveBeenCalled();
		expect(fake.editor.setText).toHaveBeenCalledWith("");
		expect(fake.widgetText(ASK_USER_WIDGET_KEY)).toBeUndefined();

		await fake.submitEditorText("second message");
		expect(fake.session.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(fake.session.prompt).toHaveBeenCalledWith(
			"second message",
			expect.objectContaining({ streamingBehavior: "steer" }),
		);
	});

	it("keeps slash and bash commands out of the comment path", async () => {
		const fake = createFakeInteractiveMode({ isStreaming: false });
		const pending = fake.createExtensionUIContext().question?.(buildRequest(), { timeout: 30 * 60_000 });
		if (!pending) throw new Error("question() returned nothing");
		await fake.submitEditorText("/debug");
		expect(fake.handleDebugCommand).toHaveBeenCalledTimes(1);
		expect(fake.session.sendUserMessage).not.toHaveBeenCalled();
		expect(fake.widgetText(ASK_USER_WIDGET_KEY)).toContain("Question pending");
	});

	it("returns to the widget on Esc without sending anything", async () => {
		const fake = createFakeInteractiveMode({ isStreaming: true });
		const pending = fake.createExtensionUIContext().question?.(buildRequest(), { timeout: 30 * 60_000 });
		if (!pending) throw new Error("question() returned nothing");

		fake.pressEditorKey(ALT_A);
		overlay(fake)?.handleInput(ESC);

		expect(overlay(fake)).toBeUndefined();
		expect(fake.editorContainer.children).toContain(fake.editor);
		expect(fake.widgetText(ASK_USER_WIDGET_KEY)).toContain("Question pending (1 unanswered)");
		expect(fake.session.sendUserMessage).not.toHaveBeenCalled();

		await fake.submitEditorText("ok go");
		await pending;
		expect(fake.session.sendUserMessage).toHaveBeenCalledTimes(1);
	});

	it("drops the widget on abort without delivering", async () => {
		const fake = createFakeInteractiveMode();
		const controller = new AbortController();
		const pending = fake
			.createExtensionUIContext()
			.question?.(buildRequest(), { timeout: 30 * 60_000, signal: controller.signal });
		if (!pending) throw new Error("question() returned nothing");
		controller.abort();
		expect(await pending).toMatchObject({ status: "cancelled", unanswered: ["auth"] });
		expect(fake.widgetText(ASK_USER_WIDGET_KEY)).toBeUndefined();
		expect(fake.session.sendUserMessage).not.toHaveBeenCalled();
	});

	it("moves the ask-user wake source 1 -> 0 through the real extension", async () => {
		const wakeEvents: unknown[] = [];
		let api: ExtensionAPI | undefined;
		const h = await createHarness({
			extensionFactories: [
				{
					factory: (pi) => {
						api = pi;
						pi.events.on("wake_source_state", (event) => wakeEvents.push(event));
						askUserExtension(pi);
					},
				},
			],
			settings: { askUser: { enabled: true } },
		});
		harnesses.push(h);
		await h.session.bindExtensions({});
		const runner = h.getExtensionRunner();
		const fake = createFakeInteractiveMode({ isStreaming: true });
		const ctx: ExtensionContext = {
			...runner.createContext(),
			mode: "tui",
			hasUI: true,
			ui: { ...runner.createContext().ui, question: fake.createExtensionUIContext().question },
		};
		const tool = runner.getAllRegisteredTools().find((t) => t.definition.name === "ask_user_question")?.definition;
		if (!tool) throw new Error("ask_user_question is not registered");

		const result = await tool.execute(
			"tc-async",
			{ questions: [{ header: "Library", question: "Which library?", multiSelect: false }], waitForAnswer: false },
			undefined,
			undefined,
			ctx,
		);
		expect(result.details).toMatchObject({ accepted: true, status: "pending" });
		expect(wakeEvents).toEqual([
			{ source: "ask-user", activeCount: 1, items: [{ id: "tc-async", description: "Library" }] },
		]);
		expect(fake.widgetText(ASK_USER_WIDGET_KEY)).toContain("Question pending (1 unanswered)");

		if (!api) throw new Error("extension factory never ran");
		const settled = new Promise<void>((resolve) => {
			api?.events.on("wake_source_state", () => resolve());
		});
		await fake.submitEditorText("just use bun");
		await settled;
		expect(wakeEvents).toEqual([
			{ source: "ask-user", activeCount: 1, items: [{ id: "tc-async", description: "Library" }] },
			{ source: "ask-user", activeCount: 0, items: [] },
		]);
		expect(fake.session.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(String(fake.session.sendUserMessage.mock.calls[0]?.[0])).toContain("[Answer to question tc-async]");
	});

	it("drives the widget from a host question record and answers on the host channel", async () => {
		vi.useFakeTimers();
		const fake = createFakeInteractiveMode({ isStreaming: true });
		const sendHostUiProgress = vi.fn();
		fake.runtimeHost = { ...fake.runtimeHost, sendHostUiProgress };
		const handler = Reflect.get(InteractiveMode.prototype, "handleHostUiRequest");
		if (typeof handler !== "function") throw new Error("handleHostUiRequest missing");
		const pending: Promise<unknown> = handler.call(fake, {
			id: "ui-9",
			method: "question",
			requestId: "req-9",
			toolCallId: "tc-9",
			waitForAnswer: false,
			questions: buildRequest().questions,
			timeout: 30 * 60_000,
			askedAtMs: 0,
			deadlineAtMs: 30 * 60_000,
			remainingMs: 30 * 60_000,
		});

		expect(fake.widgetText(ASK_USER_WIDGET_KEY)).toContain("Question pending (1 unanswered)");
		expect(overlay(fake)).toBeUndefined();

		fake.pressEditorKey(ALT_A);
		overlay(fake)?.handleInput("2");
		vi.advanceTimersByTime(1_000);
		expect(sendHostUiProgress).toHaveBeenCalledWith({
			type: "extension_ui_progress",
			id: "ui-9",
			answers: { auth: { selected: ["API key"] } },
		});

		overlay(fake)?.handleInput(ESC);
		expect(fake.widgetText(ASK_USER_WIDGET_KEY)).toContain("Question pending (0 unanswered)");
		await fake.submitEditorText("go with the key");
		expect(await pending).toEqual({
			type: "extension_ui_response",
			id: "ui-9",
			answers: { auth: { selected: ["API key"] } },
			comment: "go with the key",
		});
		expect(fake.session.sendUserMessage).not.toHaveBeenCalled();
		expect(fake.widgetText(ASK_USER_WIDGET_KEY)).toBeUndefined();
	});

	it("renders the shortcut hint from the registered key", () => {
		const fake = createFakeInteractiveMode();
		void fake.createExtensionUIContext().question?.(buildRequest(), { timeout: 30 * 60_000 });
		expect(stripAnsi(fake.widgetText(ASK_USER_WIDGET_KEY) ?? "")).toContain(
			ASK_USER_ANSWER_KEY.replace("alt", process.platform === "darwin" ? "option" : "alt"),
		);
	});
});
