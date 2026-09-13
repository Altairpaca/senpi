#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as preparation from "./prepare-bun-compile-assets.mjs";
import * as build from "./qa/read-summary-build.mjs";
import * as rpc from "./qa/read-summary-rpc.mjs";

// #1639: a heuristic selection must not gain an install-dependent parser.
describe("read-summary compile contract", () => {
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

	it("reports an immutable empty selected asset set", () => {
		// Given the frozen heuristic-only selection, when requesting its compile manifest.
		assert.equal(typeof preparation.getReadSummaryCompileAssets, "function");
		const assets = preparation.getReadSummaryCompileAssets();
		// Then no parser runtime or grammar is required, even after a repeated request.
		assert.deepEqual(assets, []);
		assert(Object.isFrozen(assets));
		assert.strictEqual(preparation.getReadSummaryCompileAssets(), assets);
	});

	it("emits the same empty manifest from preparation in a clean directory", () => {
		// Given no installed optional compile packages.
		const root = mkdtempSync(join(tmpdir(), "read-summary-assets-"));
		try {
			const invoke = () =>
				spawnSync(process.execPath, [fileURLToPath(new URL("./prepare-bun-compile-assets.mjs", import.meta.url))], {
					cwd: root,
					encoding: "utf8",
					env: { ...process.env, PI_BUN_COMPILE_REPO_ROOT: root },
				});
			// When preparation runs twice, then its machine manifest is stable.
			const first = invoke();
			const second = invoke();
			assert.equal(first.status, 0, first.stderr);
			assert.equal(second.status, 0, second.stderr);
			const manifests = first.stdout.split("\n").filter((line) => line.startsWith("{"));
			assert.equal(manifests.length, 1);
			assert.deepEqual(JSON.parse(manifests[0]), { readSummaryAssets: [] });
			assert.equal(second.stdout, first.stdout);
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

	it("fails explicitly at initialization when a required prepared asset is missing", () => {
		// Given a real executable prepared-data module, not a substitute read tool.
		const root = mkdtempSync(join(tmpdir(), "read-summary-missing-"));
		try {
			const path = join(root, "theme.cjs");
			writeFileSync(join(root, "dark.json"), "{}");
			writeFileSync(
				path,
				'const fs = require("node:fs");\nJSON.parse(fs.readFileSync(require("node:path").join(__dirname, "dark.json"), "utf8"));\nconsole.log("INITIALIZED");\n',
			);
			assert.equal(spawnSync(process.execPath, [path]).status, 0);
			assert.equal(typeof build.corruptRequiredCompileAsset, "function");
			// When the compiled required theme lookup points to a missing packaged asset.
			build.corruptRequiredCompileAsset(path);
			const result = spawnSync(process.execPath, [path], { encoding: "utf8" });
			// Then startup fails, names the missing asset, and never reports initialization success.
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /ENOENT/);
			assert.match(result.stderr, /read-summary-required-theme\.missing\.json/);
			assert.doesNotMatch(result.stdout, /INITIALIZED/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
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
