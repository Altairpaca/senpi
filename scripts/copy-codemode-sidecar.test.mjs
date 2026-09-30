import assert from "node:assert/strict";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { spawnSync } from "node:child_process";

const scriptPath = resolve("scripts/copy-codemode-sidecar.mjs");
const manifestPath = resolve("packages/senpi-codemode/package.json");
const fixturePackageRoot = resolve("packages/senpi-codemode/node_modules/fake-codemode-dependency");
let outputRoot;

afterEach(() => {
	if (outputRoot) {
		rmSync(outputRoot, { recursive: true, force: true });
		outputRoot = undefined;
	}
	rmSync(fixturePackageRoot, { recursive: true, force: true });
});

function runCopier(env = {}) {
	outputRoot = mkdtempSync(join(tmpdir(), "senpi-codemode-sidecar-"));
	return spawnSync(process.execPath, [scriptPath, outputRoot], {
		cwd: resolve("."),
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
}

describe("copy-codemode-sidecar", () => {
	it("copies the source-only runtime payload into the binary node_modules layout", () => {
		const result = runCopier();
		const target = join(outputRoot, "node_modules", "@code-yeongyu", "senpi-codemode");

		assert.equal(result.status, 0, result.stderr);
		for (const path of [
			"package.json",
			"README.md",
			"CHANGELOG.md",
			"LICENSE",
			"src/index.ts",
			"src/skill/bun-1-4/SKILL.md",
			"src/kernels/js/worker-entry.js",
			"src/kernels/js/inline-worker-entry.js",
			"src/kernels/py/prelude.py",
			"src/kernels/rb/runner.rb",
			"src/kernels/jl/runner.jl",
		]) {
			assert.equal(existsSync(join(target, path)), true, `missing copied runtime file: ${path}`);
		}
		assert.equal(existsSync(join(outputRoot, "node_modules", "@babel", "parser", "package.json")), true);
		assert.equal(existsSync(join(outputRoot, "node_modules", "@babel", "parser", "lib", "index.js")), true);
		assert.equal(existsSync(join(target, "test")), false);
		assert.equal(existsSync(join(target, "node_modules", "@code-yeongyu", "senpi")), false);
	});

	it("replaces stale sidecar contents instead of merging them", () => {
		outputRoot = mkdtempSync(join(tmpdir(), "senpi-codemode-sidecar-"));
		const target = join(outputRoot, "node_modules", "@code-yeongyu", "senpi-codemode");
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "stale.txt"), "stale");

		const result = spawnSync(process.execPath, [scriptPath, outputRoot], {
			cwd: resolve("."),
			encoding: "utf8",
		});

		assert.equal(result.status, 0, result.stderr);
		assert.equal(existsSync(join(target, "stale.txt")), false);
		assert.equal(existsSync(join(target, "src", "index.ts")), true);
	});

	it("copies a dependency declared by a fixture manifest", () => {
		const originalManifest = readFileSync(manifestPath, "utf8");
		const manifest = JSON.parse(originalManifest);
		manifest.dependencies["fake-codemode-dependency"] = "1.0.0";
		mkdirSync(fixturePackageRoot, { recursive: true });
		writeFileSync(
			join(fixturePackageRoot, "package.json"),
			JSON.stringify({
				name: "fake-codemode-dependency",
				version: "1.0.0",
				dependencies: { "fake-codemode-transitive": "1.0.0" },
			}),
		);
		writeFileSync(join(fixturePackageRoot, "index.js"), "export const fixture = true;\n");
		const transitiveRoot = join(
			fixturePackageRoot,
			"node_modules",
			"fake-codemode-transitive",
		);
		mkdirSync(transitiveRoot, { recursive: true });
		writeFileSync(
			join(transitiveRoot, "package.json"),
			JSON.stringify({ name: "fake-codemode-transitive", version: "1.0.0" }),
		);
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

		try {
			const result = runCopier();
			const target = join(outputRoot, "node_modules", "fake-codemode-dependency");

			assert.equal(result.status, 0, result.stderr);
			assert.equal(existsSync(join(target, "package.json")), true);
			assert.equal(existsSync(join(target, "index.js")), true);
			assert.equal(
				existsSync(
					join(outputRoot, "node_modules", "fake-codemode-transitive", "package.json"),
				),
				true,
			);
		} finally {
			writeFileSync(manifestPath, originalManifest);
			rmSync(transitiveRoot, { recursive: true, force: true });
		}
	});

	it("names an unresolvable declared dependency", () => {
		const originalManifest = readFileSync(manifestPath, "utf8");
		const manifest = JSON.parse(originalManifest);
		manifest.dependencies["fake-dep-does-not-exist"] = "1.0.0";
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

		try {
			const result = runCopier();
			assert.equal(result.status, 1);
			assert.match(result.stderr, /fake-dep-does-not-exist/);
		} finally {
			writeFileSync(manifestPath, originalManifest);
		}
	});

	it("supports excluding one package for stripped-sidecar tests", () => {
		const result = runCopier({ SENPI_SIDECAR_EXCLUDE: "@babel/parser" });
		const target = join(outputRoot, "node_modules", "@babel", "parser");

		assert.equal(result.status, 0, result.stderr);
		assert.equal(existsSync(target), false);
	});
});
