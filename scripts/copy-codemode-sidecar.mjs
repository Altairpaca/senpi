#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, parse, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const [outputRootArgument, manifestPathArgument] = process.argv.slice(2);
if (!outputRootArgument) {
	throw new Error("Usage: copy-codemode-sidecar.mjs <binary-output-root> [manifest-path]");
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const manifestPath = resolve(manifestPathArgument ?? join(repoRoot, "packages", "senpi-codemode", "package.json"));
const sourceRoot = dirname(manifestPath);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
// Parse the loader's table without importing its entire runtime graph during packaging.
// Package roots include all virtual subpaths; host-only dependency trees are never walked.
const loaderPath = join(repoRoot, "packages", "coding-agent", "src", "core", "extensions", "loader.ts");
const virtualTable = readFileSync(loaderPath, "utf8").match(/const VIRTUAL_MODULES:[^{]+\{([\s\S]*?)\n\};/);
if (!virtualTable) {
	throw new Error(`Unable to read VIRTUAL_MODULES from ${loaderPath}`);
}
const HOST_PROVIDED_MODULES = new Set(
	Array.from(virtualTable[1].matchAll(/^\s*(?:"([^"]+)"|([\w$]+)):\s*/gm), (match) => {
		const specifier = match[1] ?? match[2];
		return specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
	}),
);
const targetRoot = join(
	resolve(outputRootArgument),
	"node_modules",
	"@code-yeongyu",
	"senpi-codemode",
);
const sidecarNodeModulesRoot = join(resolve(outputRootArgument), "node_modules");

if (!Array.isArray(manifest.files)) {
	throw new Error(`${manifestPath} must declare a files array`);
}

// This node_modules tree is owned by the sidecar copier, including its dependency closure.
rmSync(sidecarNodeModulesRoot, { recursive: true, force: true });
mkdirSync(targetRoot, { recursive: true });
cpSync(manifestPath, join(targetRoot, "package.json"));

for (const entry of manifest.files) {
	if (typeof entry !== "string" || isAbsolute(entry)) {
		throw new Error(`Invalid codemode package file entry: ${JSON.stringify(entry)}`);
	}
	const normalizedEntry = normalize(entry);
	if (normalizedEntry === ".." || normalizedEntry.startsWith(`..${sep}`)) {
		throw new Error(`Codemode package file escapes its source root: ${entry}`);
	}
	const sourcePath = join(sourceRoot, normalizedEntry);
	if (!existsSync(sourcePath)) {
		throw new Error(`Codemode package file does not exist: ${sourcePath}`);
	}
	cpSync(sourcePath, join(targetRoot, normalizedEntry), { recursive: true, dereference: true });
}

const excludedPackage = process.env.SENPI_SIDECAR_EXCLUDE;
const copiedPackages = new Map();
const pendingPackages = Object.keys(manifest.dependencies ?? {}).map((packageName) => [
	packageName,
	manifestPath,
	join(targetRoot, "package.json"),
]);

function resolvePackageManifest(packageName, requiringManifestPath) {
	const require = createRequire(requiringManifestPath);
	try {
		return require.resolve(`${packageName}/package.json`);
	} catch (error) {
		if (!(error instanceof Error) || error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") {
			throw new Error(`Unable to resolve codemode sidecar dependency ${packageName}`, { cause: error });
		}
		for (const searchRoot of require.resolve.paths(packageName) ?? []) {
			const candidate = join(searchRoot, packageName, "package.json");
			if (existsSync(candidate)) {
				return candidate;
			}
		}
		throw new Error(`Unable to resolve codemode sidecar dependency ${packageName}`, { cause: error });
	}
}

while (pendingPackages.length > 0) {
	const [packageName, requiringManifestPath, requiringTargetManifestPath] = pendingPackages.pop();
	if (HOST_PROVIDED_MODULES.has(packageName) || packageName === excludedPackage) {
		continue;
	}

	const packageManifestPath = realpathSync(resolvePackageManifest(packageName, requiringManifestPath));
	const packageRoot = dirname(packageManifestPath);
	const requiringRoot = dirname(requiringTargetManifestPath);
	let visiblePackage;
	for (
		let parentRoot = requiringRoot;
		parentRoot !== parse(parentRoot).root;
		parentRoot = dirname(parentRoot)
	) {
		const candidate = join(parentRoot, "node_modules", packageName);
		if (copiedPackages.has(candidate)) {
			visiblePackage = copiedPackages.get(candidate);
			break;
		}
	}
	if (visiblePackage === packageRoot) {
		continue;
	}
	// Hoist only while the name is free. A conflicting version belongs beside its dependent.
	const packageTarget = visiblePackage
		? join(requiringRoot, "node_modules", packageName)
		: join(sidecarNodeModulesRoot, packageName);
	const packageManifest = JSON.parse(readFileSync(packageManifestPath, "utf8"));
	cpSync(packageRoot, packageTarget, {
		recursive: true,
		dereference: true,
		filter: (sourcePath) => sourcePath !== join(packageRoot, "node_modules"),
	});
	copiedPackages.set(packageTarget, packageRoot);
	for (const dependencyName of Object.keys(packageManifest.dependencies ?? {})) {
		pendingPackages.push([dependencyName, packageManifestPath, join(packageTarget, "package.json")]);
	}
}

console.log(
	`[copy-codemode-sidecar] copied ${manifest.files.length} entries and ${copiedPackages.size} runtime packages to ${targetRoot}`,
);
