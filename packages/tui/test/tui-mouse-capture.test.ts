import assert from "node:assert/strict";
import { it } from "node:test";
import { Text } from "../src/components/text.ts";
import { TuiBase } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class CaptureTui extends TuiBase {
	readonly mode = "regular" as const;
	readonly tracking: boolean[] = [];
	override applyMouseTracking(enabled: boolean): void {
		this.tracking.push(enabled);
	}
	block(on: boolean): void {
		this.setMouseBlocker("suspended", on);
	}
	line(row: number): number | undefined {
		return this.resolveFrameLine(row);
	}
}

it("leases transition only at zero and release idempotently (#1645)", () => {
	const tui = new CaptureTui(new VirtualTerminal(80, 24));
	const a = tui.acquireMouseCapture("pending-question");
	const b = tui.acquireMouseCapture("always");
	assert.deepEqual(tui.tracking, [true]);
	a();
	a();
	assert.deepEqual(tui.tracking, [true]);
	b();
	b();
	assert.deepEqual(tui.tracking, [true, false]);
	tui.stop();
});
it("blockers preserve lease intent and stop resets bookkeeping", () => {
	const tui = new CaptureTui(new VirtualTerminal(80, 24));
	const old = tui.acquireMouseCapture("pending-question");
	tui.block(true);
	tui.block(false);
	assert.deepEqual(tui.tracking, [true, false, true]);
	tui.stop();
	old();
	const next = tui.acquireMouseCapture("always");
	next();
	assert.deepEqual(tui.tracking, [true, false, true, true, false]);
	tui.stop();
});
it("unknown first-frame anchor cannot misfire", () => {
	const tui = new CaptureTui(new VirtualTerminal(80, 24));
	tui.addChild(new Text("a\nb\nc\nd\ne", 0, 0));
	tui.renderNow();
	assert.equal(tui.line(3), undefined);
	tui.stop();
});
it("cleared short frame maps only visible committed lines", () => {
	const terminal = new VirtualTerminal(80, 24);
	const tui = new CaptureTui(terminal);
	tui.addChild(new Text("a\nb\nc\nd\ne", 0, 0));
	tui.renderNow(true);
	assert.equal(tui.line(3), 2);
	assert.equal(tui.line(9), undefined);
	assert.equal(tui.line(0), undefined);
	terminal.resize(100, 24);
	assert.equal(tui.line(3), undefined);
	tui.renderNow();
	assert.equal(tui.line(3), 2);
	tui.stop();
});
it("viewport frame maps the bottom row to the last frame line", () => {
	const tui = new CaptureTui(new VirtualTerminal(80, 24));
	tui.addChild(new Text(Array.from({ length: 40 }, (_, i) => String(i)).join("\n"), 0, 0));
	tui.renderNow();
	assert.equal(tui.line(24), 39);
	assert.equal(tui.line(1), 16);
	assert.equal(tui.line(25), undefined);
	tui.stop();
});
it("images invalidate even a cleared frame", () => {
	const tui = new CaptureTui(new VirtualTerminal(80, 24));
	tui.addChild({ render: () => ["\x1b_Ga=T,f=100;AAAA\x1b\\"], invalidate: () => {} });
	tui.renderNow(true);
	assert.equal(tui.line(1), undefined);
	tui.stop();
});
