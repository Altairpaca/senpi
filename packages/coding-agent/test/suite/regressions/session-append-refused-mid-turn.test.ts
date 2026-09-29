import { chmodSync, readFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

/**
 * A turn whose messages the session file refuses (EACCES; ENOSPC or a removed directory in the
 * field) must surface the failure to the prompt and must not leave those messages in the
 * SessionManager: the next turn's entries would otherwise chain onto parents the file never got.
 */

interface DiskEntry {
	type: string;
	id: string;
	parentId?: string | null;
}

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

function diskEntries(file: string): DiskEntry[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as DiskEntry)
		.filter((entry) => entry.type !== "session");
}

describe("a turn whose session writes are refused", () => {
	it("rejects the prompt, keeps the refused messages out of the session, and the next turn chains onto the file", async () => {
		// Given a persisted session whose first turn reached the file
		const harness = await createHarness({ persistSession: true, extensionFactories: [] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("first reply"),
			fauxAssistantMessage("refused reply"),
			fauxAssistantMessage("third reply"),
		]);
		await harness.session.prompt("first");
		const file = harness.sessionManager.getSessionFile();
		if (!file) throw new Error("test setup: persisted session has no file");
		const lastWritten = harness.sessionManager.getLeafId();

		// When the second turn runs while the file is read-only
		chmodSync(file, 0o444);
		const refused = await harness.session.prompt("second").then(
			() => undefined,
			(error: unknown) => error,
		);
		chmodSync(file, 0o644);
		// And a third turn runs once the file is writable again
		await harness.session.prompt("third");

		// Then the second prompt reported the refused write and the session is idle again
		expect(refused).toMatchObject({ code: "EACCES" });
		expect(harness.session.isStreaming).toBe(false);
		// And the third turn's user message is a child of the last entry the file received
		const onDisk = diskEntries(file);
		const thirdUser = onDisk.find((entry) => entry.parentId === lastWritten);
		expect(thirdUser).toBeDefined();
		// And every parent named in the file is in the file, with memory matching it exactly
		const diskIds = new Set(onDisk.map((entry) => entry.id));
		expect(onDisk.filter((entry) => entry.parentId && !diskIds.has(entry.parentId))).toEqual([]);
		expect(harness.sessionManager.getEntries().map((entry) => entry.id)).toEqual(onDisk.map((entry) => entry.id));
	});
});
