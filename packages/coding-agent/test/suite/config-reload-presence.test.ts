import { mkdir, mkdtempDisposable, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME } from "../../src/config.ts";
import { createConfigReloadHarness } from "./config-reload-harness.ts";

afterEach(() => vi.useRealTimers());

describe("project configuration directory discovery", () => {
	it("keeps the active generation when the first request creates only runtime state", async () => {
		// Given: a new project has no configuration directory yet.
		await using agent = await mkdtempDisposable(join(tmpdir(), "config-presence-"));
		const { harness, reloads, notify } = await createConfigReloadHarness(agent.path);
		try {
			vi.useFakeTimers();
			// When: first-turn task setup creates runtime state under that directory.
			await mkdir(join(harness.tempDir, CONFIG_DIR_NAME, "senpi-task", "runtime"), { recursive: true });
			await notify(harness.tempDir, CONFIG_DIR_NAME);
			// Then: no configuration changed, so the tool generation remains active.
			expect(reloads).toEqual([]);
		} finally {
			await harness.getExtensionRunner().emit({ type: "session_shutdown", reason: "quit" });
			harness.cleanup();
		}
	});

	it("reloads settings that arrive together with the new configuration directory", async () => {
		// Given: a new project has no configuration directory yet.
		await using agent = await mkdtempDisposable(join(tmpdir(), "config-presence-settings-"));
		const { harness, reloads, notify } = await createConfigReloadHarness(agent.path);
		try {
			vi.useFakeTimers();
			// When: an editor creates the directory and its settings before the watch event.
			await mkdir(join(harness.tempDir, CONFIG_DIR_NAME));
			await writeFile(join(harness.tempDir, CONFIG_DIR_NAME, "settings.json"), '{"theme":"light"}');
			await notify(harness.tempDir, CONFIG_DIR_NAME);
			// Then: the discovered settings still request one reload.
			expect(reloads).toEqual([true]);
		} finally {
			await harness.getExtensionRunner().emit({ type: "session_shutdown", reason: "quit" });
			harness.cleanup();
		}
	});

	it("keeps watching for settings after runtime-only directory creation", async () => {
		// Given: the runtime-only directory has been discovered.
		await using agent = await mkdtempDisposable(join(tmpdir(), "config-presence-later-"));
		const { harness, reloads, notify } = await createConfigReloadHarness(agent.path);
		try {
			vi.useFakeTimers();
			const configDir = join(harness.tempDir, CONFIG_DIR_NAME);
			await mkdir(join(configDir, "senpi-task", "runtime"), { recursive: true });
			await notify(harness.tempDir, CONFIG_DIR_NAME);
			const previousRequests = reloads.length;
			// When: the user subsequently adds real configuration.
			await writeFile(join(configDir, "settings.json"), '{"theme":"light"}');
			await notify(configDir, "settings.json");
			// Then: rearming the watchers was preserved even without the first reload.
			expect(reloads.slice(previousRequests)).toEqual([true]);
		} finally {
			await harness.getExtensionRunner().emit({ type: "session_shutdown", reason: "quit" });
			harness.cleanup();
		}
	});
});
