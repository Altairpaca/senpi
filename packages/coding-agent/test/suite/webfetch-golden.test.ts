import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { htmlToMarkdown, htmlToText } from "../../src/core/extensions/builtin/webfetch/webfetch/content.ts";
import {
	capWebfetchOutput,
	DEFAULT_OUTPUT_MAX_BYTES,
} from "../../src/core/extensions/builtin/webfetch/webfetch/tool.ts";

const fixtures = [
	"01-reader",
	"02-explicit",
	"03-tistory",
	"04-title",
	"05-lines",
	"06-entities",
	"07-redirect",
	"08-readable-urls",
	"09-explicit-urls",
	"10-base-redirect",
	"11-malformed",
	"12-multibyte",
] as const;
// Recorded final URL: fixture 10 is served after /fixtures/base/start redirects here.
const finalUrl = "https://example.test/fixtures/base/final";
const fixtureDirectory = new URL("../fixtures/webfetch/", import.meta.url);

function normalize(value: string): string {
	return value
		.replace(/\r\n/g, "\n")
		.replace(/[\t ]+$/gm, "")
		.replace(/\n$/, "");
}

describe("webfetch base-implementation goldens", () => {
	for (const fixture of fixtures) {
		for (const format of ["md", "txt"] as const) {
			it(`preserves ${format} output when converting ${fixture}`, () => {
				// Given: verbatim legacy fixtures or deterministic URL, malformed, and size boundaries.
				const html = readFileSync(new URL(`${fixture}.html`, fixtureDirectory), "utf8");
				const goldenPath = new URL(`${fixture}.${format}.golden`, fixtureDirectory);
				// When
				const actual = format === "md" ? htmlToMarkdown(html, finalUrl) : htmlToText(html, finalUrl);
				// Then: generation is explicitly opt-in, on the unchanged jsdom implementation only.
				if (process.env.WEBFETCH_WRITE_BASE_GOLDENS === "1") writeFileSync(goldenPath, `${actual}\n`);
				expect(normalize(actual)).toBe(normalize(readFileSync(goldenPath, "utf8")));
			});
		}
	}

	it("caps complete UTF-8 output when the multibyte article exceeds 50 KiB", () => {
		// Given
		const html = readFileSync(new URL("12-multibyte.html", fixtureDirectory), "utf8");
		const markdown = htmlToMarkdown(html, finalUrl);
		// When
		const capped = capWebfetchOutput(markdown);
		// Then
		expect(capped.truncated).toBe(true);
		expect(capped.totalBytes).toBeGreaterThan(DEFAULT_OUTPUT_MAX_BYTES);
		expect(capped.outputBytes).toBeLessThanOrEqual(DEFAULT_OUTPUT_MAX_BYTES);
		expect(capped.text).not.toContain("\uFFFD");
	});
});
