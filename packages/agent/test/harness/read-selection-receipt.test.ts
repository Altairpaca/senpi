import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { READ_FOLDER_SELECTION, selectedReadFolder } from "../../src/harness/utils/read-folders/index.ts";
import { sha256 } from "./fixtures/read-summary/scorer.ts";

it("binds the shipped registry to a tracked, reproducible selection receipt (#1639)", () => {
	const receipt = new URL("./fixtures/read-summary/selection.json", import.meta.url);
	const bytes = readFileSync(receipt);
	const selection = JSON.parse(bytes.toString("utf8"));
	const trackedPath = relative(process.cwd(), fileURLToPath(receipt));
	expect(execFileSync("git", ["ls-files", "--error-unmatch", trackedPath], { encoding: "utf8" }).trim()).toBe(trackedPath);
	expect(sha256(bytes)).toBe(READ_FOLDER_SELECTION.selectionSha256);
	expect(selection.head_sha).toBe(READ_FOLDER_SELECTION.head);
	expect(selection.default_read_selection).toEqual({
		wasm: READ_FOLDER_SELECTION.wasm,
		rawReasons: READ_FOLDER_SELECTION.rawReasons,
		languages: READ_FOLDER_SELECTION.languages,
		folder: { id: selectedReadFolder.id, version: selectedReadFolder.version },
	});
	for (const language of ["ts", "js", "json"] as const) {
		const row = selection.languages.find((entry: { language: string }) => entry.language === language);
		expect(row.invalid_boundaries).toEqual([]);
		expect(row.engine).toBe(READ_FOLDER_SELECTION.languages[language]);
	}
	for (const [path, hash] of Object.entries(selection.candidate_sources_sha256)) {
		expect(sha256(readFileSync(new URL(`../../src/harness/utils/${path}`, import.meta.url)))).toBe(hash);
	}
});
