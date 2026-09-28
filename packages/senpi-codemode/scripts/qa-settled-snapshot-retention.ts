import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult, ExtensionContext } from "@code-yeongyu/senpi";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";
import { EvalDetachedCellManager } from "../src/tool/detached-cell-manager.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";

const PNG_1X1_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

class QaScenarioError extends Error {
	readonly name = "QaScenarioError";
}

function context(cwd: string, mode: "print" | "tui", steeringSignal?: AbortSignal): ExtensionContext {
	return Object.assign(Object.create(null), {
		mode,
		hasUI: mode === "tui",
		cwd,
		model: undefined,
		signal: undefined,
		steeringSignal,
	});
}

function images(result: AgentToolResult<unknown>): number {
	return result.content.filter((part) => part.type === "image").length;
}

function expectEqual(actual: unknown, expected: unknown, label: string): void {
	const shown = JSON.stringify(actual);
	if (shown !== JSON.stringify(expected)) throw new QaScenarioError(`${label}: ${shown} !== ${JSON.stringify(expected)}`);
	console.log(`${label}: ${shown}`);
}

async function main(): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "senpi-settled-retention-"));
	const pngPath = join(root, "tiny.png");
	await writeFile(pngPath, Buffer.from(PNG_1X1_BASE64, "base64"));
	const gateEntered = Promise.withResolvers<void>();
	const releaseGate = Promise.withResolvers<void>();
	const kernel = new JavaScriptKernel({ sessionId: `qa-retention-${crypto.randomUUID()}`, cwd: root, parallelPoolWidth: 2 });
	const manager = new EvalDetachedCellManager({ artifactsDir: root });
	const tool = createEvalTool({
		enabledLanguages: { js: true, py: false, rb: false, jl: false },
		kernelManager: { getKernel: async () => kernel },
		cellTimeoutSeconds: 1,
		executeTool: async (name) => {
			if (name !== "read") throw new QaScenarioError(`unexpected host tool call: ${name}`);
			gateEntered.resolve();
			await releaseGate.promise;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
		cellManager: manager,
	});
	const show = `display(await Bun.file(${JSON.stringify(pngPath)}).arrayBuffer());`;
	const peek = (cellId: string) =>
		tool.execute(`peek-${cellId}`, { action: "peek", cell_id: cellId }, undefined, undefined, context(root, "tui"));
	try {
		const foreground = await tool.execute(
			"fg-image",
			{ language: "js", code: `${show} "fg done"`, summary: "foreground image" },
			undefined,
			undefined,
			context(root, "print"),
		);
		expectEqual(images(foreground), 1, "FOREGROUND_RESULT_IMAGES");
		const foregroundPeek = await peek("fg-image");
		expectEqual(images(foregroundPeek), 0, "FOREGROUND_PEEK_IMAGES");
		expectEqual(foregroundPeek.details.cells?.[0]?.output, foreground.details.cells?.[0]?.output, "FOREGROUND_PEEK_OUTPUT");

		const steering = new AbortController();
		const execution = tool.execute(
			"bg-image",
			{
				language: "js",
				code: `${show} await tool.read({ path: "gate" }); "bg done"`,
				summary: "detached image",
				on_timeout: "detach",
			},
			undefined,
			undefined,
			context(root, "tui", steering.signal),
		);
		await Promise.race([gateEntered.promise, execution]);
		steering.abort();
		const detached = await execution;
		expectEqual(detached.details.cells?.[0]?.status, "detached", "DETACHED_STATUS");
		const terminal = manager.waitForTerminal("bg-image");
		releaseGate.resolve();
		await terminal;
		expectEqual(images(await peek("bg-image")), 1, "DETACHED_PEEK_IMAGES");

		await tool.execute(
			"reset-js",
			{ language: "js", code: "1", summary: "reset", reset: true },
			undefined,
			undefined,
			context(root, "print"),
		);
		expectEqual(
			manager.list().recent.map((snapshot) => snapshot.cellId),
			["reset-js"],
			"RECENT_AFTER_RESET",
		);
		for (const cellId of ["fg-image", "bg-image"]) {
			const outcome = await peek(cellId).then(
				() => "known",
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			);
			expectEqual(outcome, `Unknown detached eval cell "${cellId}"`, `PEEK_AFTER_RESET_${cellId}`);
		}
		console.log("QA_SETTLED_RETENTION_PASS: true");
	} finally {
		releaseGate.resolve();
		await manager.dispose();
		await kernel.close();
		await rm(root, { recursive: true, force: true });
		console.log(`CLEANUP: removed ${root}; kernel closed`);
	}
}

await main().catch((error: unknown) => {
	console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
	process.exitCode = 1;
});
