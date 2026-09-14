import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { lockPathPackageChain, stagePublishDependencies } from "./prepare-senpi-publish-dependencies.mjs";

const internalPackageNames = new Set(["@earendil-works/pi-ai"]);
let tempDir;

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function writePackage(root, name, version = "1.0.0") {
	const packageDir = join(root, "node_modules", name);
	mkdirSync(packageDir, { recursive: true });
	writeFileSync(join(packageDir, "package.json"), `${JSON.stringify({ name, version }, undefined, "\t")}\n`);
	return packageDir;
}

function writeManifest(root, packages) {
	const manifestPath = join(root, "packages", "coding-agent", "publish-deps.lock.json");
	mkdirSync(dirname(manifestPath), { recursive: true });
	writeFileSync(manifestPath, JSON.stringify({ name: "@code-yeongyu/senpi", version: "0.0.0", lockfileVersion: 3, packages }));
}

function stagedVersion(root, lockPath) {
	const packageJson = join(root, "packages", "coding-agent", lockPath, "package.json");
	return existsSync(packageJson) ? JSON.parse(readFileSync(packageJson, "utf8")).version : undefined;
}

describe("lockPathPackageChain", () => {
	it("splits top-level, scoped and nested lock paths and rejects everything else", () => {
		assert.deepEqual(lockPathPackageChain("node_modules/typebox"), ["typebox"]);
		assert.deepEqual(lockPathPackageChain("node_modules/@scope/pkg"), ["@scope/pkg"]);
		assert.deepEqual(lockPathPackageChain("node_modules/a/node_modules/@scope/b"), ["a", "@scope/b"]);
		for (const rejected of ["", "packages/coding-agent", "node_modules/.bin", "node_modules/@scope", "node_modules/a/dist"]) {
			assert.equal(lockPathPackageChain(rejected), undefined, rejected);
		}
	});
});

describe("stagePublishDependencies", () => {
	it("stages a nested manifest entry from the installer-hoisted copy and prunes packages the manifest dropped", () => {
		// Given: bun hoisted htmlparser2's entities@7 to the root, while the staged tree still
		// carries entities@8 and parse5 from the previous (jsdom) graph plus a stale nested dep.
		tempDir = mkdtempSync(join(tmpdir(), "senpi-stage-nested-"));
		writePackage(tempDir, "htmlparser2", "10.1.0");
		writePackage(tempDir, "entities", "7.0.1");
		const stagedRoot = join(tempDir, "packages", "coding-agent");
		writePackage(stagedRoot, "entities", "8.0.0");
		writePackage(stagedRoot, "parse5", "8.0.1");
		writePackage(join(stagedRoot, "node_modules", "htmlparser2"), "stale-nested");
		writePackage(stagedRoot, "@earendil-works/pi-ai");
		// ...and a scoped parent whose scoped child is nested at the same place under the root install.
		writePackage(tempDir, "@aws-sdk/token-providers", "3.1127.0");
		writePackage(writePackage(tempDir, "@aws-sdk/credential-provider-sso", "3.973.15"), "@aws-sdk/token-providers", "3.1129.0");
		writeManifest(tempDir, {
			"": { dependencies: { htmlparser2: "10.1.0", "@aws-sdk/credential-provider-sso": "3.973.15" } },
			"node_modules/htmlparser2": { version: "10.1.0" },
			"node_modules/htmlparser2/node_modules/entities": { version: "7.0.1" },
			"node_modules/@aws-sdk/token-providers": { version: "3.1127.0" },
			"node_modules/@aws-sdk/credential-provider-sso": { version: "3.973.15" },
			"node_modules/@aws-sdk/credential-provider-sso/node_modules/@aws-sdk/token-providers": { version: "3.1129.0" },
		});

		// When
		stagePublishDependencies(tempDir, internalPackageNames);

		// Then: the tree mirrors the manifest; internal workspaces are left for their own staging.
		assert.equal(stagedVersion(tempDir, "node_modules/htmlparser2"), "10.1.0");
		assert.equal(stagedVersion(tempDir, "node_modules/htmlparser2/node_modules/entities"), "7.0.1");
		assert.equal(stagedVersion(tempDir, "node_modules/entities"), undefined);
		assert.equal(stagedVersion(tempDir, "node_modules/parse5"), undefined);
		assert.equal(stagedVersion(tempDir, "node_modules/htmlparser2/node_modules/stale-nested"), undefined);
		assert.equal(stagedVersion(tempDir, "node_modules/@earendil-works/pi-ai"), "1.0.0");
		assert.equal(stagedVersion(tempDir, "node_modules/@aws-sdk/token-providers"), "3.1127.0");
		assert.equal(stagedVersion(tempDir, "node_modules/@aws-sdk/credential-provider-sso/node_modules/@aws-sdk/token-providers"), "3.1129.0");
	});

	it("never substitutes a copy of another version and finds the matching copy nested under another dependent", () => {
		// Given: the manifest hoists x@2 while the developer's install hoisted x@1 and nested x@2 under a.
		tempDir = mkdtempSync(join(tmpdir(), "senpi-stage-version-"));
		writePackage(tempDir, "x", "1.0.0");
		writePackage(writePackage(tempDir, "a", "1.0.0"), "x", "2.0.0");
		writeManifest(tempDir, {
			"": { dependencies: { a: "1.0.0", x: "2.0.0" } },
			"node_modules/a": { version: "1.0.0" },
			"node_modules/x": { version: "2.0.0" },
		});

		// When
		stagePublishDependencies(tempDir, internalPackageNames);

		// Then
		assert.equal(stagedVersion(tempDir, "node_modules/x"), "2.0.0");
		assert.equal(stagedVersion(tempDir, "node_modules/a"), "1.0.0");
	});

	it("fails loudly with the expected version when no installed copy matches the manifest", () => {
		tempDir = mkdtempSync(join(tmpdir(), "senpi-stage-mismatch-"));
		writePackage(tempDir, "x", "1.0.0");
		writeManifest(tempDir, { "": { dependencies: { x: "2.0.0" } }, "node_modules/x": { version: "2.0.0" } });

		assert.throws(() => stagePublishDependencies(tempDir, internalPackageNames), /Missing .*node_modules\/x@2\.0\.0 for node_modules\/x/);
	});

	it("keeps a materialized optional package in place when the root install lacks it", () => {
		// Given: publish.mjs downloaded a platform optional straight into the staged tree.
		tempDir = mkdtempSync(join(tmpdir(), "senpi-stage-optional-"));
		writePackage(join(tempDir, "packages", "coding-agent"), "platform-opt", "3.0.0");
		writeManifest(tempDir, {
			"": { optionalDependencies: { "platform-opt": "3.0.0", "absent-opt": "1.0.0" } },
			"node_modules/platform-opt": { version: "3.0.0", optional: true },
			"node_modules/platform-opt/node_modules/absent-child": { version: "1.0.0", optional: true },
			"node_modules/absent-opt": { version: "1.0.0", optional: true },
			"node_modules/absent-opt/node_modules/absent-child": { version: "1.0.0", optional: true },
		});

		// When
		stagePublishDependencies(tempDir, internalPackageNames);

		// Then
		assert.equal(stagedVersion(tempDir, "node_modules/platform-opt"), "3.0.0");
		assert.equal(stagedVersion(tempDir, "node_modules/absent-opt"), undefined);
		assert.equal(existsSync(join(tempDir, "packages", "coding-agent", "node_modules", "absent-opt")), false);
	});
});
