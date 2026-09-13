import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { ProcessTerminal, parseCursorPositionResponse } from "../src/terminal.ts";

function scriptedTerminal(t: TestContext, response?: string, negotiate = false) {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	const old = process.env.PI_TUI_KEYBOARD_PROTOCOL;
	process.env.PI_TUI_KEYBOARD_PROTOCOL = negotiate ? "1" : "0";
	const writes: string[] = [];
	const input: string[] = [];
	t.mock.method(process.stdin, "resume", () => process.stdin);
	t.mock.method(process.stdin, "pause", () => process.stdin);
	t.mock.method(process, "kill", () => true);
	t.mock.method(process.stdout, "write", ((chunk: string | Uint8Array) => {
		const text = String(chunk);
		writes.push(text);
		if (text === "\x1b[?6n" && response) process.stdin.emit("data", response);
		return true;
	}) as typeof process.stdout.write);
	const terminal = new ProcessTerminal();
	terminal.start(
		(data) => input.push(data),
		() => {},
	);
	t.after(() => {
		terminal.stop();
		if (old === undefined) delete process.env.PI_TUI_KEYBOARD_PROTOCOL;
		else process.env.PI_TUI_KEYBOARD_PROTOCOL = old;
	});
	return { terminal, writes, input, send: (data: string) => process.stdin.emit("data", data) };
}
it("rejects bare CPR-shaped function keys (#1645)", () => {
	assert.equal(parseCursorPositionResponse("\x1b[1;2R"), undefined);
});
for (const [reply, expected] of [
	["\x1b[?12;1R", { row: 12, column: 1 }],
	["\x1b[?12;1;1R", { row: 12, column: 1, page: 1 }],
] as const) {
	it(`resolves synchronous private reply ${JSON.stringify(reply)}`, async (t) => {
		const { terminal, input, writes } = scriptedTerminal(t, reply);
		assert.deepEqual(await terminal.queryCursorPosition(), expected);
		assert.deepEqual(input, []);
		assert.equal(writes.filter((w) => w === "\x1b[?6n").length, 1);
	});
}
it("shares one pending query and preserves interleaved keyboard input", async (t) => {
	const { terminal, input, send } = scriptedTerminal(t);
	const first = terminal.queryCursorPosition();
	assert.equal(terminal.queryCursorPosition(), first);
	send("a");
	send("\x1b[?12;");
	send("1;1R");
	assert.deepEqual(await first, { row: 12, column: 1, page: 1 });
	assert.deepEqual(input, ["a"]);
	send("\x1b[?12;1R");
	assert.deepEqual(input, ["a"]);
});
it("forwards bare replies and times out instead of interpreting function keys", async (t) => {
	const { terminal, input, send } = scriptedTerminal(t);
	const query = terminal.queryCursorPosition();
	send("\x1b[12;1R");
	t.mock.timers.tick(750);
	assert.equal(await query, undefined);
	assert.deepEqual(input, ["\x1b[12;1R"]);
});
it("discards late private replies after bounded timeout", async (t) => {
	const { terminal, input, send } = scriptedTerminal(t);
	const query = terminal.queryCursorPosition();
	t.mock.timers.tick(750);
	assert.equal(await query, undefined);
	send("\x1b[?12;1R");
	assert.deepEqual(input, []);
});
it("does not leak a late fragmented private response tail", async (t) => {
	const { terminal, input, send } = scriptedTerminal(t);
	const query = terminal.queryCursorPosition();
	send("\x1b[?12;");
	t.mock.timers.tick(50);
	t.mock.timers.tick(150);
	t.mock.timers.tick(550);
	assert.equal(await query, undefined);
	send("1R");
	assert.deepEqual(input, []);
	send("a");
	assert.deepEqual(input, ["a"]);
});
it("issues CPR only after keyboard negotiation settles", async (t) => {
	const { terminal, writes, send } = scriptedTerminal(t, undefined, true);
	const query = terminal.queryCursorPosition();
	assert.equal(writes.includes("\x1b[?6n"), false);
	send("\x1b[?1u");
	assert.equal(writes.includes("\x1b[?6n"), true);
	send("\x1b[?12;1R");
	assert.deepEqual(await query, { row: 12, column: 1 });
});
