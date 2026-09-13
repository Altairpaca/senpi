#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { binaryIdentity, stageReadRuntime } from "./read-summary-build.mjs";
import { readSummaryControl, readSurface } from "./read-summary-parity.mjs";

const { values } = parseArgs({ options: { binary: { type: "string" }, out: { type: "string" } }, strict: true });
assert(values.binary && isAbsolute(values.binary));
assert(values.out && isAbsolute(values.out));
const directory = dirname(values.out);
mkdirSync(directory, { recursive: true });
const startedAt = new Date().toISOString();
try {
	const control = readSummaryControl();
	const files = [
		control,
		{ ...control, id: "javascript", path: "javascript.js" },
		{ ...control, id: "unsupported", path: "unsupported.rs" },
	];
	const sourceDirectory = mkdtempSync(join(directory, "source-"));
	const binaryDirectory = mkdtempSync(join(directory, "binary-"));
	const sourceLayout = stageReadRuntime(sourceDirectory);
	const binaryLayout = stageReadRuntime(binaryDirectory, values.binary);
	const source = await readSurface(sourceLayout.command, sourceDirectory, files);
	const binary = await readSurface(binaryLayout.command, binaryDirectory, files);
	assert.deepEqual(binary.records, source.records);
	assert.deepEqual(binary.fresh, source.fresh);
	assert(source.records[0].elided.length > 0);
	assert(source.records[1].elided.length > 0);
	assert.deepEqual(source.records[2].elided, []);
	writeFileSync(
		values.out,
		`${JSON.stringify(
			{
				passed: true,
				startedAt,
				finishedAt: new Date().toISOString(),
				platform: process.platform,
				arch: process.arch,
				artifact: binaryIdentity(values.binary),
				source,
				binary,
				paidProviderCalls: 0,
			},
			null,
			2,
		)}\n`,
	);
	console.log(JSON.stringify({ passed: true, out: values.out }));
} catch (error) {
	writeFileSync(
		`${values.out}.error.json`,
		`${JSON.stringify({ passed: false, startedAt, error: error instanceof Error ? error.stack : String(error) }, null, 2)}\n`,
	);
	throw error;
}
