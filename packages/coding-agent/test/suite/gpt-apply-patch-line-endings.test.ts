import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPatchDetailed, createApplyPatchTool } from "../../src/core/extensions/builtin/gpt-apply-patch/index.ts";

const tempDirectories: string[] = [];

async function workspaceWith(name: string, content: string): Promise<{ cwd: string; file: string }> {
	const cwd = await mkdtemp(path.join(tmpdir(), "senpi-apply-patch-endings-"));
	tempDirectories.push(cwd);
	const file = path.join(cwd, name);
	await writeFile(file, content);
	return { cwd, file };
}

afterEach(async () => {
	await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

// Protects the file-content contract of an update: only the lines a patch changes are rewritten, so CRLF and
// mixed-ending files no longer turn into whole-file diffs (Codex scenarios 023/024).
describe("gpt-apply-patch line endings", () => {
	it("keeps CRLF on every line when a CRLF file gets a change and an insertion", async () => {
		const { cwd, file } = await workspaceWith("lines.txt", "one\r\ntwo\r\nthree\r\n");

		const result = await applyPatchDetailed(
			cwd,
			"*** Begin Patch\n*** Update File: lines.txt\n@@\n-one\n+ONE\n two\n+between\n three\n*** End Patch\n",
		);

		expect(result.failures).toEqual([]);
		expect(await readFile(file, "utf8")).toBe("ONE\r\ntwo\r\nbetween\r\nthree\r\n");
	});

	it("leaves untouched lines of a mixed-ending file with their own endings", async () => {
		const { cwd, file } = await workspaceWith("lines.txt", "one\r\ntwo\rthree\nfour\r\n");

		const result = await applyPatchDetailed(
			cwd,
			"*** Begin Patch\n*** Update File: lines.txt\n@@\n one\n two\n-three\n+THREE\n four\n*** End Patch\n",
		);

		expect(result.failures).toEqual([]);
		expect(await readFile(file, "utf8")).toBe("one\r\ntwo\rTHREE\r\nfour\r\n");
	});

	it("leaves a context line matched only after trimming exactly as it was", async () => {
		const { cwd, file } = await workspaceWith("code.ts", "const a = 1;   \r\nconst b = 2;\r\n");

		const result = await applyPatchDetailed(
			cwd,
			"*** Begin Patch\n*** Update File: code.ts\n@@\n const a = 1;\n-const b = 2;\n+const b = 3;\n*** End Patch\n",
		);

		expect(result.failures).toEqual([]);
		expect(await readFile(file, "utf8")).toBe("const a = 1;   \r\nconst b = 3;\r\n");
	});

	it("keeps an LF file LF and still ends it with a newline", async () => {
		const { cwd, file } = await workspaceWith("lines.txt", "alpha\nbeta");

		const result = await applyPatchDetailed(
			cwd,
			"*** Begin Patch\n*** Update File: lines.txt\n@@\n-beta\n+BETA\n*** End Patch\n",
		);

		expect(result.failures).toEqual([]);
		expect(await readFile(file, "utf8")).toBe("alpha\nBETA\n");
	});

	it("reports a context mismatch on a CRLF file and leaves its bytes untouched", async () => {
		const original = "one\r\ntwo\r\n";
		const { cwd, file } = await workspaceWith("lines.txt", original);

		const result = await applyPatchDetailed(
			cwd,
			"*** Begin Patch\n*** Update File: lines.txt\n@@\n-missing\n+x\n*** End Patch\n",
		);

		expect(result.appliedFiles).toEqual([]);
		expect(result.failures.map((failure) => failure.filePath)).toEqual(["lines.txt"]);
		expect(await readFile(file, "utf8")).toBe(original);
	});

	it("counts only the changed line in the tool's diff for a one-line change to a CRLF file", async () => {
		const { cwd, file } = await workspaceWith("sample.txt", "keep\r\nbefore\r\nkeep too\r\n");
		const tool = createApplyPatchTool();

		const result = await tool.execute(
			"apply-patch-crlf-preview",
			{ input: "*** Begin Patch\n*** Update File: sample.txt\n@@\n-before\n+after\n*** End Patch" },
			undefined,
			undefined,
			{ cwd } as never,
		);

		expect(result.details?.preview).toMatchObject({ added: 1, removed: 1 });
		expect(await readFile(file, "utf8")).toBe("keep\r\nafter\r\nkeep too\r\n");
	});
});
