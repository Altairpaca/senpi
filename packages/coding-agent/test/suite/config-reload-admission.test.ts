import { mkdtempDisposable, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfigReloadHarness } from "./config-reload-harness.ts";

afterEach(() => vi.useRealTimers());

describe("config reload during first-message admission", () => {
	// omo#9365: a prompt can be admitted before the provider's agent run is marked active.
	it("defers a configuration reload until the admitted first request finishes", async () => {
		// Given: the real session is waiting on an asynchronous first-turn extension.
		await using root = await mkdtempDisposable(join(tmpdir(), "config-admission-"));
		await writeFile(join(root.path, "settings.json"), '{"theme":"dark"}');
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { harness, reloads, notify } = await createConfigReloadHarness(root.path, (pi) => {
			pi.on("before_agent_start", async () => {
				entered.resolve();
				await release.promise;
			});
		});
		harness.setResponses([fauxAssistantMessage("First request completed.")]);
		vi.useFakeTimers();
		const prompt = harness.session.prompt("Handle the first request");
		try {
			await entered.promise;
			// When: a watched configuration file changes during prompt admission.
			await writeFile(join(root.path, "settings.json"), '{"theme":"light"}');
			await notify(root.path, "settings.json");
			// Then: the host is not asked to retire the extension handling that request.
			expect([...reloads]).toEqual([]);
			release.resolve();
			await prompt;
			expect(reloads).toEqual([true]);
		} finally {
			release.resolve();
			await prompt;
			await harness.getExtensionRunner().emit({ type: "session_shutdown", reason: "quit" });
			harness.cleanup();
		}
	});

	it("rechecks idleness when a prompt starts during an asynchronous reload veto", async () => {
		// Given: a pending configuration reload is still consulting an extension.
		await using root = await mkdtempDisposable(join(tmpdir(), "config-veto-admission-"));
		await writeFile(join(root.path, "settings.json"), '{"theme":"dark"}');
		const vetoEntered = Promise.withResolvers<void>();
		const releaseVeto = Promise.withResolvers<void>();
		const providerEntered = Promise.withResolvers<void>();
		const releaseProvider = Promise.withResolvers<void>();
		const { harness, reloads, notify } = await createConfigReloadHarness(root.path, (pi) => {
			pi.on("session_before_reload", async () => {
				vetoEntered.resolve();
				await releaseVeto.promise;
			});
		});
		harness.setResponses([
			async () => {
				providerEntered.resolve();
				await releaseProvider.promise;
				return fauxAssistantMessage("First request completed.");
			},
		]);
		vi.useFakeTimers();
		await writeFile(join(root.path, "settings.json"), '{"theme":"light"}');
		await notify(root.path, "settings.json");
		await vetoEntered.promise;
		const prompt = harness.session.prompt("Handle the first request");
		try {
			await providerEntered.promise;
			// When: the old idle check finishes after the provider request has started.
			releaseVeto.resolve();
			await vi.advanceTimersByTimeAsync(0);
			// Then: reload stays pending until that request has settled.
			expect([...reloads]).toEqual([]);
			releaseProvider.resolve();
			await prompt;
			expect(reloads).toEqual([true]);
		} finally {
			releaseVeto.resolve();
			releaseProvider.resolve();
			await prompt;
			await harness.getExtensionRunner().emit({ type: "session_shutdown", reason: "quit" });
			harness.cleanup();
		}
	});
});
