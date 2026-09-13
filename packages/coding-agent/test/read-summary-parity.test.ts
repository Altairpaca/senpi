import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../agent/src/harness/context.ts";
import { NodeExecutionEnv } from "../../agent/src/harness/env/nodejs.ts";
import { createReadTool as createHarnessRead } from "../../agent/src/harness/tools/read.ts";
import { createAllToolDefinitions, createCodingTools, createReadOnlyTools } from "../src/core/tools/index.ts";
import { createReadTool } from "../src/core/tools/read.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";
import { cancellationParity } from "./support/read-summary-cancel.ts";
import {
	assertSummary,
	invocation,
	privateDir,
	readerNames,
	readers,
	source,
	textOutput,
} from "./support/read-summary-fixture.ts";
import { fallbackParity, folderFallbacks, summaryParity } from "./support/read-summary-parity-cases.ts";
import { consumeSessionFixture } from "./support/read-summary-session-fixture.ts";

describe("structural read parity (#1639)", () => {
	it("renders identical source segments, schema fields and reread coordinates with the same folder", summaryParity);
	it("preserves actual truncator inclusivity and every explicit range/prose fallback", fallbackParity);
	it("preserves missing-folder, parse-failure, unsupported, no-summary and thrown-error paths", folderFallbacks);
	it(
		"rejects repeated interrupts without folding stale operations or poisoning fresh reads",
		cancellationParity,
		10000,
	);
	it(
		"consumes every historical fixture entry through read validation and both result converters",
		consumeSessionFixture,
	);
	it("injects the frozen selection in both default factories", () =>
		privateDir(async (cwd) => {
			// Given a supported source file; when the default factories read it; then both summarize.
			await writeFile(join(cwd, "x.ts"), source());
			assertSummary(textOutput(await createReadTool(cwd).execute("default", { path: "x.ts" })));
			assertSummary(
				textOutput(
					await createHarnessRead().execute(
						"default",
						{ path: "x.ts" },
						() => {},
						{ env: new NodeExecutionEnv({ cwd }) },
						invocation,
						BACKGROUND_CONTEXT,
					),
				),
			);
		}));
	it("summarizes exactly 100 source lines and selected JS/JSON but not 99", () =>
		privateDir(async (cwd) => {
			const tools = readers(cwd);
			for (const [path, text, summary] of [
				["x.ts", source(99), false],
				["x.ts", source(100), true],
				["x.js", source(), true],
				[
					"x.json",
					JSON.stringify(
						Array.from({ length: 20 }, () => Array.from({ length: 12 }, (_, i) => i)),
						null,
						2,
					),
					true,
				],
			] as const) {
				await writeFile(join(cwd, path), text);
				for (const name of readerNames) {
					const output = textOutput(await tools.read(name, { path }));
					if (summary) assertSummary(output);
					else assert.equal(output, text);
				}
			}
		}));
	it("keeps the selected folder when normal session construction supplies image and policy options", () =>
		privateDir(async (cwd) => {
			await writeFile(join(cwd, "x.ts"), source());
			const options = {
				read: { autoResizeImages: false, filesystemPolicy: async () => ({ allow: true as const }) },
			};
			const tools = [
				wrapToolDefinition(createAllToolDefinitions(cwd, options).read),
				...createCodingTools(cwd, options).filter((tool) => tool.name === "read"),
				...createReadOnlyTools(cwd, options).filter((tool) => tool.name === "read"),
			];
			assert.equal(tools.length, 3);
			for (const tool of tools) assertSummary(textOutput(await tool.execute("session", { path: "x.ts" })));
		}));
	it("keeps image detection ahead of folding, even when the file is named ts", () =>
		privateDir(async (cwd) => {
			// Given image magic plus enough trailing bytes to look summary-sized; when read; then no folder is called.
			const png = Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==",
				"base64",
			);
			await writeFile(join(cwd, "image.ts"), Buffer.concat([png, Buffer.from(source())]));
			const tools = readers(cwd, {
				folder: {
					id: "reject",
					version: "1",
					fold: () => {
						throw new Error("Image must not fold");
					},
				},
			});
			for (const name of readerNames) {
				const output = await tools.read(name, { path: "image.ts" });
				assert(output.content.some((block) => block.type === "image"));
			}
		}));
});
