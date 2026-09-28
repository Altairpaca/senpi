import type { AgentToolResult } from "@code-yeongyu/senpi";
import { describe, expect, it } from "vitest";
import type { EvalDetachedCellSnapshot } from "../src/tool/detached-cell-contract.ts";
import { EvalDetachedCellManager } from "../src/tool/detached-cell-manager.ts";
import { TerminalSnapshotStore } from "../src/tool/terminal-snapshot-store.ts";
import type { EvalToolDetails } from "../src/tool/types.ts";
import { FakeKernel } from "./eval/fakes.ts";

const MIB = 1024 * 1024;
const TWO_MIB_IMAGE = "A".repeat(2 * MIB);

function imageResult(index: number, image: string, jsonOutputs?: readonly unknown[]): AgentToolResult<EvalToolDetails> {
	return {
		content: [
			{ type: "text", text: `output-${index}` },
			{ type: "image", mimeType: "image/png", data: image },
		],
		details: {
			language: "js",
			languages: ["js"],
			summary: `cell ${index}`,
			durationMs: 1,
			toolCalls: [],
			truncated: false,
			...(jsonOutputs === undefined ? {} : { jsonOutputs }),
			cells: [
				{
					index: 0,
					summary: `cell ${index}`,
					code: String(index),
					language: "js",
					output: `output-${index}`,
					status: "complete",
					durationMs: 1,
				},
			],
		},
	};
}

function settleForeground(manager: EvalDetachedCellManager, id: string, result: AgentToolResult<EvalToolDetails>) {
	const cell = manager.create(id, { language: "js", code: id, summary: id });
	manager.markRunning(cell);
	manager.complete(cell, result);
}

function settleDetached(manager: EvalDetachedCellManager, id: string, result: AgentToolResult<EvalToolDetails>) {
	const cell = manager.create(id, { language: "js", code: id, summary: id });
	manager.markRunning(cell);
	manager.bindKernel(cell, new FakeKernel([]), () => result);
	expect(manager.detach(cell)).toBe(true);
	manager.complete(cell, result);
}

function imageParts(snapshot: EvalDetachedCellSnapshot) {
	return snapshot.result.content.filter((part) => part.type === "image");
}

// senpi#2259: settled-cell snapshots must not pin already-delivered images or grow past a byte budget.
describe("settled-cell snapshot retention (#2259)", () => {
	it("keeps no image part of 40 settled foreground cells while text and JSON outputs stay peekable", async () => {
		const manager = new EvalDetachedCellManager();
		try {
			for (let i = 0; i < 40; i++) settleForeground(manager, `fg-${i}`, imageResult(i, TWO_MIB_IMAGE, [{ i }]));
			const recent = manager.list().recent;
			expect(recent).toHaveLength(32);
			expect(recent.flatMap(imageParts)).toEqual([]);
			const newest = manager.peek("fg-39");
			expect(newest.result.content).toEqual([{ type: "text", text: "output-39" }]);
			expect(newest.result.details.jsonOutputs).toEqual([{ i: 39 }]);
		} finally {
			await manager.dispose();
		}
	});

	it("keeps a detached cell's images for peek after it settles", async () => {
		const manager = new EvalDetachedCellManager();
		try {
			settleDetached(manager, "bg", imageResult(1, TWO_MIB_IMAGE));
			expect(imageParts(manager.peek("bg"))).toEqual([
				{ type: "image", mimeType: "image/png", data: TWO_MIB_IMAGE },
			]);
		} finally {
			await manager.dispose();
		}
	});

	it("evicts the oldest detached image snapshots beyond the byte budget and keeps the newest", async () => {
		const manager = new EvalDetachedCellManager({ retainedResultsBytes: 5 * MIB });
		try {
			for (let i = 0; i < 4; i++) settleDetached(manager, `bg-${i}`, imageResult(i, TWO_MIB_IMAGE));
			expect(manager.list().recent.map((snapshot) => snapshot.cellId)).toEqual(["bg-2", "bg-3"]);
			expect(() => manager.peek("bg-1")).toThrow(/Unknown detached eval cell/);
		} finally {
			await manager.dispose();
		}
	});

	it("never exceeds the byte budget except for a single newest snapshot, and 0 keeps only the count cap", () => {
		const snapshot = (cellId: string, image: string): EvalDetachedCellSnapshot => ({
			cellId,
			language: "js",
			startedAtMs: 0,
			state: "completed",
			outputTail: "",
			result: imageResult(0, image),
			stateRetained: true,
		});
		const budgeted = new TerminalSnapshotStore({ byteBudget: 3 * MIB });
		for (let i = 0; i < 6; i++) {
			budgeted.remember(snapshot(`s-${i}`, TWO_MIB_IMAGE.slice(0, MIB)));
			expect(budgeted.bytes).toBeLessThanOrEqual(3 * MIB);
		}
		budgeted.remember(snapshot("huge", `${TWO_MIB_IMAGE}${TWO_MIB_IMAGE}`));
		expect(budgeted.list().map((entry) => entry.cellId)).toEqual(["huge"]);
		budgeted.forgetLanguage("js");
		expect(budgeted.bytes).toBe(0);

		const countOnly = new TerminalSnapshotStore({ cap: 3, byteBudget: 0 });
		for (let i = 0; i < 5; i++) countOnly.remember(snapshot(`c-${i}`, TWO_MIB_IMAGE));
		expect(countOnly.list().map((entry) => entry.cellId)).toEqual(["c-2", "c-3", "c-4"]);
	});
});
