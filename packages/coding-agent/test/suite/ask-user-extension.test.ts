import { afterEach, describe, expect, it, vi } from "vitest";
import askUserExtension from "../../src/core/extensions/builtin/ask-user/index.ts";
import { getPendingQuestions } from "../../src/core/extensions/builtin/ask-user/registry.ts";
import { WAIT_FLAG_STEER_TEXT } from "../../src/core/extensions/builtin/ask-user/schema.ts";
import { mapSdkToolNameToPi, resolveSdkTools } from "../../src/core/extensions/builtin/claude-sdk-oauth/tools.ts";
import type { ExtensionContext, QuestionResponse } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./harness.ts";

const args = { questions: [{ header: "Library", question: "Which library?", multiSelect: false }], waitForAnswer: true };
const answer: QuestionResponse = { status: "answered", answers: { q1: { selected: ["A"] } }, unanswered: [] };
const harnesses: Harness[] = [];
async function setup(enabled = true, flag = false) {
 const h = await createHarness({ extensionFactories: [{ factory: askUserExtension }], settings: { askUser: { enabled } }, extensionFlagValues: new Map([["no-ask-user", flag]]) });
 harnesses.push(h);
 await h.session.bindExtensions({});
 const runner = h.getExtensionRunner();
 const ctx: ExtensionContext = { ...runner.createContext(), mode: "tui", hasUI: true, ui: { ...runner.createContext().ui, question: vi.fn(async () => answer) } };
 const tool = runner.getAllRegisteredTools().find(t => t.definition.name === "ask_user_question")?.definition;
 return { h, runner, ctx, tool };
}
function required<T>(value: T | undefined): T { if (value === undefined) throw new Error("missing tool"); return value; }
afterEach(() => { for (const h of harnesses.splice(0)) h.cleanup(); vi.useRealTimers(); });
describe("ask-user builtin", () => {
 it("activates exactly one family and swaps on model_select", async () => {
  const { h, runner } = await setup();
  expect(h.session.getActiveToolNames()).toContain("ask_user_question");
  await runner.emit({ type: "model_select", model: { ...h.getModel(), id: "gpt-5.6", api: "openai-responses" }, previousModel: h.getModel(), source: "set" });
  expect(h.session.getActiveToolNames()).toContain("request_user_input");
  expect(h.session.getActiveToolNames()).not.toContain("ask_user_question");
  await runner.emit({ type: "model_select", model: h.getModel(), source: "set" });
  expect(h.session.getActiveToolNames()).toContain("ask_user_question");
  expect(h.session.getActiveToolNames()).not.toContain("request_user_input");
 });
 it.each([[false, false], [true, true]])("does not register when disabled (%s, flag %s)", async (enabled, flag) => {
  const { runner } = await setup(enabled, flag);
  expect(runner.getAllRegisteredTools().filter(t => ["ask_user_question", "request_user_input"].includes(t.definition.name))).toEqual([]);
 });
 it("returns blocking answers through the formatter", async () => {
  const { tool, ctx } = await setup();
  const result = await required(tool).execute("blocking", args, undefined, undefined, ctx);
  expect(result.content).toEqual([{ type: "text", text: "Library: A" }]);
  expect(result.details).toMatchObject({ status: "answered", answers: { "Which library?": "A" } });
 });
 it("returns async acceptance before answer and tracks wake source until settlement", async () => {
  const { tool, ctx } = await setup();
  const completion = Promise.withResolvers<QuestionResponse>();
  const resolved = Promise.withResolvers<void>();
  ctx.ui.question = vi.fn(() => completion.promise);
  const result = await required(tool).execute("async", { ...args, waitForAnswer: false }, undefined, undefined, ctx);
  expect(result.details).toMatchObject({ accepted: true, requestId: "async", status: "pending" });
  expect(ctx.ui.question).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ deliver: "user-message" }));
  const pending = required(getPendingQuestions(ctx.sessionManager.getSessionId())[0]);
  pending.completion.then(() => resolved.resolve());
  completion.resolve(answer);
  await resolved.promise;
  expect(getPendingQuestions(ctx.sessionManager.getSessionId())).toEqual([]);
 });
 it.each(["tui", "print", "json", "rpc"])("deactivates unavailable %s calls", async mode => {
  const { h, tool, ctx } = await setup();
  if (mode !== "tui" && mode !== "print" && mode !== "json" && mode !== "rpc") throw new Error("mode");
  ctx.mode = mode; ctx.hasUI = false;
  expect((await required(tool).execute("none", args, undefined, undefined, ctx)).details).toMatchObject({ status: "unavailable" });
  expect(h.session.getActiveToolNames()).not.toContain("ask_user_question");
  expect(ctx.ui.question).not.toHaveBeenCalled();
 });
 it("round trips the SDK custom-tool name through host blocking execution", async () => {
  const { tool, ctx } = await setup();
  const definition = required(tool);
  const mapped = resolveSdkTools({ messages: [], tools: [definition] });
  const wireName = mapped.customToolNameToSdk.get(definition.name);
  expect(wireName).toBe("mcp__custom-tools__ask_user_question");
  expect(mapSdkToolNameToPi(required(wireName), mapped.customToolNameToPi)).toBe(definition.name);
  expect((await definition.execute("sdk", args, undefined, undefined, ctx)).details).toMatchObject({ status: "answered" });
 });
 it("rejects a missing wait flag before opening UI", async () => {
  const { tool, ctx } = await setup();
  const result = await required(tool).execute("missing", { questions: args.questions }, undefined, undefined, ctx);
  expect(result.content).toEqual([{ type: "text", text: WAIT_FLAG_STEER_TEXT }]);
  expect(ctx.ui.question).not.toHaveBeenCalled();
 });
 it("times out deterministically, guards this turn, and resets on agent_end", async () => {
  vi.useFakeTimers();
  const { tool, ctx, runner } = await setup();
  ctx.ui.question = vi.fn(() => new Promise<QuestionResponse>(() => {}));
  const first = required(tool).execute("timeout", args, undefined, undefined, ctx);
  await vi.advanceTimersByTimeAsync(1_800_000);
  expect((await first).details).toMatchObject({ status: "timed_out" });
  expect((await required(tool).execute("again", args, undefined, undefined, ctx)).details).toMatchObject({ status: "unavailable" });
  expect(ctx.ui.question).toHaveBeenCalledTimes(1);
  await runner.emit({ type: "agent_end", messages: [] });
  ctx.ui.question = vi.fn(async () => answer);
  expect((await required(tool).execute("next", args, undefined, undefined, ctx)).details).toMatchObject({ status: "answered" });
 });
});
