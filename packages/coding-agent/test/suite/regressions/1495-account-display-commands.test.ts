import { createModels, createProvider, type OAuthAuth } from "@earendil-works/pi-ai";
import { listSlots } from "@earendil-works/pi-ai/auth/pool/slots";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import accountExtension from "../../../src/core/extensions/builtin/account/index.ts";
import { registerClaudeAccountCommand } from "../../../src/core/extensions/builtin/claude-sdk-oauth/account-command.ts";
import type { ClaudeSdkOauthCredential } from "../../../src/core/extensions/builtin/claude-sdk-oauth/accounts.ts";
import { createOAuthConfig } from "../../../src/core/extensions/builtin/claude-sdk-oauth/oauth-login.ts";
import gptAccountExtension from "../../../src/core/extensions/builtin/gpt-account.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { accountFooterSuffix } from "../../../src/modes/interactive/components/footer.ts";
import { composedProvider } from "../../support/claude-sdk-oauth-provider.ts";
import { type Command, createAccountCommandContext } from "../account-command-harness.ts";

const fresh = { type: "oauth" as const, access: "fake-access", refresh: "fake-refresh", expires: 4102444800000 };
const flow: OAuthAuth = {
	name: "Fake",
	login: async () => fresh,
	refresh: async (current) => current,
	toAuth: async (current) => ({ apiKey: current.access }),
};
function command(name: string): Command {
	const commands = new Map<string, Command>();
	const pi = {
		registerCommand: (key: string, value: Command) => commands.set(key, value),
		registerFlag: () => {},
		on: () => {},
	} as unknown as ExtensionAPI;
	gptAccountExtension(pi);
	registerClaudeAccountCommand(pi, { loadSettings: () => ({}), environment: () => undefined });
	accountExtension(pi);
	return commands.get(name)!;
}

// senpi#1495: all account commands address IDs; only labels change.
describe.each([
	["gpt-account", "openai-codex", ""],
	["claude-account", "claude-sdk-oauth", ""],
	["account", "openai-codex", "openai-codex "],
])("/%s display names", (name, provider, prefix) => {
	it("renames multi-word labels, lists safely, pins by ID, and clears metadata", async () => {
		const storage = AuthStorage.inMemory({
			[provider]: {
				...fresh,
				accounts: [
					{ ...fresh, name: "default", source: "login" },
					{ ...fresh, name: "second", source: "login" },
				],
			},
		});
		const { ctx, notices } = createAccountCommandContext(storage, "/tmp");
		const handler = command(name).handler;
		await handler(`${prefix}rename second   Work account  `, ctx);
		expect(listSlots(storage.get(provider))[1].displayName).toBe("Work account");
		await handler(`${prefix}list`, ctx);
		expect(notices.at(-1)?.message).toContain("Work account (second)");
		expect(JSON.stringify(notices)).not.toContain("fake-");
		await handler(`${prefix}pin Work account`, ctx);
		expect(storage.get(provider)).not.toHaveProperty("pinned");
		await handler(`${prefix}pin second`, ctx);
		expect(storage.get(provider)).toHaveProperty("pinned", "second");
		expect(accountFooterSuffix(storage.get(provider), "session-01")).toBe("@Work account (second)");
		await handler(`${prefix}clear-name second`, ctx);
		expect(listSlots(storage.get(provider))[1]).not.toHaveProperty("displayName");
	});

	it("rejects missing names and duplicates without changing the credential", async () => {
		const storage = AuthStorage.inMemory({
			[provider]: {
				...fresh,
				accounts: [
					{ ...fresh, name: "default", source: "login", displayName: "Personal" },
					{ ...fresh, name: "second", source: "login" },
				],
			},
		});
		const before = JSON.stringify(storage.get(provider));
		const { ctx, notices } = createAccountCommandContext(storage, "/tmp");
		for (const args of ["rename second", "rename second personal", "rename missing Valid", "clear-name missing"]) {
			await command(name).handler(prefix + args, ctx);
			expect(notices.at(-1)?.type).toBe("error");
			expect(JSON.stringify(storage.get(provider))).toBe(before);
		}
	});
});

describe.each(["openai-codex", "claude-sdk-oauth"])("%s optional post-login naming", (provider) => {
	it.each(["Work account", "", undefined])(
		"names the receipt's slot after persistence; cancellation keeps login usable (%s)",
		async (answer) => {
			const storage = AuthStorage.inMemory();
			const models = createModels({ credentials: storage });
			if (provider === "openai-codex")
				models.setProvider(
					createProvider({
						id: provider,
						name: "Fake",
						baseUrl: "https://example.invalid",
						auth: { oauth: flow },
						models: [],
						api: {},
					}),
				);
			else
				models.setProvider(
					composedProvider(async () => false, {
						oauth: createOAuthConfig({
							readCurrent: async () => storage.get(provider) as ClaudeSdkOauthCredential | undefined,
							loginFlow: flow,
						}),
					}),
				);
			let persistedAtPrompt = false;
			const { ctx, notices, dialogs } = createAccountCommandContext(storage, "/tmp", {
				dialogs: {
					input: async () => {
						persistedAtPrompt = storage.has(provider);
						return answer;
					},
				},
			});
			Object.assign(ctx.modelRegistry, { modelRuntime: models });
			await command(provider === "openai-codex" ? "gpt-account" : "claude-account").handler("add", ctx);
			expect(persistedAtPrompt).toBe(true);
			expect(dialogs).toHaveLength(1);
			expect(listSlots(storage.get(provider))).toMatchObject([{ name: "default", access: fresh.access }]);
			expect(listSlots(storage.get(provider))[0].displayName).toBe(answer || undefined);
			expect(notices.filter((notice) => notice.type === "error")).toEqual([]);
		},
	);
});
