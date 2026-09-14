#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { build as bundle } from "esbuild";
import * as preparation from "./prepare-bun-compile-assets.mjs";
import * as build from "./qa/read-summary-build.mjs";
import * as rpc from "./qa/read-summary-rpc.mjs";

// #1639: a heuristic selection must not gain an install-dependent parser.
describe("read-summary compile contract", () => {
	it("uses the release entry graph and compile flags", () => {
		// Given the publishing contract; output relocation must not change its entry/flag graph.
		const args = build.releaseCompileArgs(build.repository, "first/senpi");
		args[args.indexOf("--outfile") + 1] = resolve("read-parity/senpi");
		assert.deepEqual(build.releaseCompileArgs(build.repository, "read-parity/senpi"), args);
		assert(!args.includes("--compile-autoload-package-json"));
	});
	it("correlates parallel read results by invocation identity, not completion order", () => {
		// Given real RPC event shapes arriving in reverse order.
		const calls = [{ id: "first" }, { id: "second" }];
		const events = calls
			.map((call) => ({
				type: "tool_execution_end",
				toolCallId: call.id,
				toolName: "read",
				isError: false,
				result: { content: [{ type: "text", text: call.id }] },
			}))
			.reverse();
		assert.equal(typeof rpc.readResultsForCalls, "function");
		// When collecting, then the complete outputs retain request identity/order.
		assert.deepEqual(
			rpc.readResultsForCalls(calls, events).map((row) => row.result.content[0].text),
			["first", "second"],
		);
	});

	it("rejects stale duplicate and misleading-success read events", () => {
		// Given a current invocation, when a foreign, missing, failed or duplicate result arrives.
		assert.equal(typeof rpc.readResultsForCalls, "function");
		const good = {
			type: "tool_execution_end",
			toolCallId: "current",
			toolName: "read",
			isError: false,
			result: { content: [{ type: "text", text: "source" }] },
		};
		for (const events of [
			[],
			[{ ...good, toolCallId: "stale" }],
			[good, good],
			[{ ...good, isError: true }],
			[{ ...good, toolName: "fixture-read" }],
			[{ type: "response", success: true }],
		]) {
			// Then no plausible metadata or older result can count as the actual current read.
			assert.throws(() => rpc.readResultsForCalls([{ id: "current" }], events));
		}
	});

	it("bundles the actual folder and view without external runtime dependencies", async () => {
		// Given the shipping feature's actual entry modules, not a self-reported empty registry.
		const folder = "packages/agent/src/harness/utils/read-folders/";
		const view = "packages/agent/src/harness/utils/segmented-read-view.ts";
		// When bundling their transitive graph; then any parser, asset or other runtime import fails this boundary.
		const result = await bundle({ absWorkingDir: build.repository, entryPoints: [`${folder}index.ts`, view],
			bundle: true, platform: "browser", format: "esm", outdir: "unused", write: false, metafile: true });
		const inputs = Object.keys(result.metafile.inputs);
		assert(inputs.includes(`${folder}brace-scanner.ts`));
		assert(inputs.every((path) => path === view || (path.startsWith(folder) && path.endsWith(".ts"))), JSON.stringify(inputs));
		assert(Object.values(result.metafile.outputs).every((output) => output.imports.length === 0));
	});

	it("derives changed release entries and quoted argv without a copied contract", () => {
		// Given an execution-owned publishing recipe with a distinct entry and a quoted path.
		const root = mkdtempSync(join(tmpdir(), "read-release-argv-"));
		try {
			mkdirSync(join(root, "scripts"));
			writeFileSync(join(root, "scripts/build-binaries.sh"), ['bun build --compile --splitting "./worker with space.ts" --outfile old', 'bun build --compile --splitting "./worker with space.ts" --outfile old.exe'].join("\n"));
			// When deriving the candidate argv; then release changes and output paths survive as individual arguments.
			assert.deepEqual(build.releaseCompileArgs(root, join(root, "new output")), ["bun", "build", "--compile", "--splitting", "./worker with space.ts", "--outfile", join(root, "new output")]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("accepts the exact binary delta ceiling and reductions", () => {
		// Given identical baseline/candidate flags, when measuring their byte difference.
		assert.equal(typeof preparation.measureReadSummaryBinaryDelta, "function");
		// Then the inclusive ceiling applies to the delta, not total executable bytes.
		assert.deepEqual(
			preparation.measureReadSummaryBinaryDelta({
				baselineBytes: 200000000,
				candidateBytes: 212582912,
				maxDeltaBytes: 12582912,
			}),
			{
				baselineBytes: 200000000,
				candidateBytes: 212582912,
				deltaBytes: 12582912,
				maxDeltaBytes: 12582912,
			},
		);
		assert.equal(
			preparation.measureReadSummaryBinaryDelta({ baselineBytes: 100, candidateBytes: 99, maxDeltaBytes: 0 })
				.deltaBytes,
			-1,
		);
	});

	it("rejects oversized binaries rather than reporting a misleading success", () => {
		// Given one byte beyond the ceiling, when measuring, then fail with a machine code.
		assert.equal(typeof preparation.measureReadSummaryBinaryDelta, "function");
		assert.throws(
			() =>
				preparation.measureReadSummaryBinaryDelta({
					baselineBytes: 200000000,
					candidateBytes: 212582913,
					maxDeltaBytes: 12582912,
				}),
			{ code: "READ_SUMMARY_BINARY_BUDGET_EXCEEDED" },
		);
	});

	it("rejects invalid byte measurements before comparing the budget", () => {
		// Given malformed boundary measurements, when measuring, then fail explicitly.
		assert.equal(typeof preparation.measureReadSummaryBinaryDelta, "function");
		for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
			for (const field of ["baselineBytes", "candidateBytes", "maxDeltaBytes"]) {
				assert.throws(
					() =>
						preparation.measureReadSummaryBinaryDelta({
							baselineBytes: 100,
							candidateBytes: 100,
							maxDeltaBytes: 0,
							[field]: value,
						}),
					{ code: "READ_SUMMARY_BINARY_MEASUREMENT_INVALID" },
				);
			}
		}
	});
});
