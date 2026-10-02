import assert from "node:assert";
import { describe, it } from "node:test";
import { CombinedAutocompleteProvider } from "../src/autocomplete.ts";

// Adapted from upstream to the fork's contextual skill discovery (see autocomplete-slash.test.ts):
// outside the explicit `skill:` namespace a skill is offered only when its bare name starts with the
// query, and typing the namespace prefix offers the `skill:` namespace item instead of every skill.
describe("CombinedAutocompleteProvider slash-command filter", () => {
	const commands = [
		{ name: "skill:deep-research", description: "Multi-agent deep research" },
		{ name: "skill:research-idea", description: "Refine a raw idea into a falsifiable seed" },
		{ name: "skill:to-sidecar", description: "Route work to a sidecar" },
		{ name: "skill:brainstorm", description: "Generate ideas" },
		{ name: "model", description: "Select the active model" },
	];

	async function suggestionsFor(prefix: string): Promise<string[]> {
		const provider = new CombinedAutocompleteProvider(commands, process.cwd());
		const line = `/${prefix}`;
		const result = await provider.getSuggestions([line], 0, line.length, {
			signal: new AbortController().signal,
		});
		assert.ok(result, `expected suggestions for "/${prefix}"`);
		return result.items.map((item) => item.value);
	}

	it("ranks the skill whose bare name matches the query first", async () => {
		const items = await suggestionsFor("research");
		assert.equal(items[0], "skill:research-idea");
		assert.ok(!items.includes("skill:deep-research"));
	});

	it("keeps ordinary slash commands matching", async () => {
		const items = await suggestionsFor("mod");
		assert.ok(items.includes("model"));
	});

	it("keeps explicit skill: queries working", async () => {
		const items = await suggestionsFor("skill:side");
		assert.ok(items.includes("skill:to-sidecar"));
	});

	it("offers the skill namespace while typing the skill prefix, then every skill inside it", async () => {
		assert.deepStrictEqual(await suggestionsFor("skill"), ["skill:"]);
		const items = await suggestionsFor("skill:");
		assert.deepStrictEqual(
			[...items].sort(),
			commands
				.filter((command) => command.name.startsWith("skill:"))
				.map((command) => command.name)
				.sort(),
		);
	});

	it("keeps fuzzy matching inside the explicit skill namespace", async () => {
		const items = await suggestionsFor("skill:bra");
		assert.ok(items.includes("skill:brainstorm"));
	});
});
