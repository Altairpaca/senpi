import { afterEach, expect, it, vi } from "vitest";
import { ConnectionQuestionBridge } from "../../src/modes/rpc/connection-question-bridge.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";

const request = { requestId: "tool-1", waitForAnswer: true, timeoutMs: 1000, questions: ["q1", "q2"].map(id => ({ id, header: id, question: id, options: [{label: "A"}, {label: "B"}], multiSelect: false })) };
afterEach(() => vi.useRealTimers());
it("broadcasts, replays once after message end, and forgets resolved questions", async () => {
 const writer = new SessionEventWriter(() => {});
 const records = new Map<string, string[]>();
 const attach = (id: string) => { const lines: string[] = []; records.set(id, lines); writer.registerConnection(id, {writeRaw: line => lines.push(line), waitForBackpressure: async () => {}}); writer.attachConnectionToSession(id, "s"); };
 attach("a"); attach("b");
 const bridge = new ConnectionQuestionBridge(record => { writer.withConnection("a", () => writer.enqueue("s", record)); });
 const answer = bridge.ask(request);
 writer.enqueue("s", {type: "message_end"});
 await writer.flush();
 expect(records.get("a")?.filter(line => line.includes('"method":"question"'))).toHaveLength(1);
 expect(records.get("b")?.filter(line => line.includes('"method":"question"'))).toHaveLength(1);
 attach("c"); writer.attachConnectionToSession("c", "s"); await writer.flush();
 expect(records.get("c")).toHaveLength(1);
 const id = bridge.pendingQuestions()[0].id;
 expect(bridge.respond({type: "extension_ui_response", id, answers: {q1: {selected: ["A"]}}, comment: ""})).toBe("question_incomplete");
 expect(bridge.pendingQuestions()).toHaveLength(1);
 expect(bridge.respond({type: "extension_ui_response", id, answers: {}, comment: "do it"})).toBe(true);
 expect(await answer).toMatchObject({status: "comment-submitted", unanswered: ["q1", "q2"]});
 await writer.flush();
 for (const peer of ["a", "b", "c"]) expect(records.get(peer)?.filter(line => line.includes('"question_resolved"'))).toHaveLength(1);
 expect(bridge.respond({type: "extension_ui_response", id, answers: {}})).toBe("question_already_resolved");
 attach("d"); await writer.flush(); expect(records.get("d")).toHaveLength(0);
});
it("progress rearms idle timeout and timeout retains the draft", async () => {
 vi.useFakeTimers();
 const output: object[] = []; const onProgress = vi.fn();
 const bridge = new ConnectionQuestionBridge(record => output.push(record));
 const answer = bridge.ask(request, {onProgress}); const id = bridge.pendingQuestions()[0].id;
 await vi.advanceTimersByTimeAsync(900);
 bridge.progress({type: "extension_ui_progress", id, answers: {q1: {selected: ["A"]}}});
 expect(onProgress).toHaveBeenCalledOnce();
 expect(output.at(-1)).toMatchObject({type: "question_updated", remainingMs: 1000});
 await vi.advanceTimersByTimeAsync(999); expect(bridge.pendingQuestions()).toHaveLength(1);
 await vi.advanceTimersByTimeAsync(1);
 expect(await answer).toMatchObject({status: "timed_out", answers: {q1: {selected: ["A"]}}});
 expect(output.at(-1)).toMatchObject({type: "question_resolved", outcome: "timed_out"});
});
it("cancels once on close and abort", async () => {
 const output: object[] = []; const bridge = new ConnectionQuestionBridge(record => output.push(record));
 const controller = new AbortController(); const answer = bridge.ask(request, {signal: controller.signal});
 controller.abort(); bridge.cancelAll(); expect(await answer).toMatchObject({status: "cancelled"});
 expect(output.filter(record => "type" in record && record.type === "question_resolved")).toHaveLength(1);
});
