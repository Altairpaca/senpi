#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/publish-npm.yml", import.meta.url), "utf8");
const codingAgentPackage = JSON.parse(
	readFileSync(new URL("../packages/coding-agent/package.json", import.meta.url), "utf8"),
);

describe("publish-only workflow", () => {
	it("installs release dependencies without native lifecycle scripts", () => {
		const installStep = workflow.match(/- name: Install dependencies[\s\S]*?(?=\n      - name: Build all workspaces)/)?.[0];
		assert.ok(installStep, "expected dependency install step");
		assert.match(installStep, /npm install --ignore-scripts --no-audit --no-fund/);
	});

	it("reuses the release validation instead of rerunning the full suite", () => {
		const publishStep = workflow.match(/- name: Publish prepared version[\s\S]*?(?=\n      - name: Workflow summary)/)?.[0];
		assert.ok(publishStep, "expected publish-only step");
		assert.match(publishStep, /node scripts\/publish\.mjs/);
		assert.doesNotMatch(publishStep, /npm run check|npm test/);
	});

	it("resets only tracked files that exist, so the reset step cannot fail on a removed path", () => {
		const resetStep = workflow.match(/- name: Reset auto-generated and npm-install drift files[\s\S]*?run: git checkout -- ([^\n]+)/);
		assert.ok(resetStep, "expected the reset step");
		const paths = resetStep[1].trim().split(/\s+/);
		assert.ok(paths.length > 0, "expected reset paths");
		for (const path of paths) {
			assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), `reset path ${path} does not exist`);
		}
	});

	it("keeps binary package scripts shell-executable", () => {
		assert.doesNotMatch(codingAgentPackage.scripts["copy-binary-assets"], /&&\s*&&/);
	});
});
