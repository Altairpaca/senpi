#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, parse, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// These modules are virtualized by the host and must not be staged in the sidecar.
const HOST_PROVIDED_MODULES = new Set(["@code-yeongyu/senpi", "typebox"]);

const [outputRootArgument] = process.argv.slice(2);
if (!outputRootArgument) {
	throw new Error("Usage: copy-codemode-sidecar.mjs <binary-output-root>");
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const sourceRoot = join(repoRoot, "packages", "senpi-codemode");
const manifestPath = join(sourceRoot, "package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
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

rmSync(targetRoot, { recursive: true, force: true });
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
	cpSync(sourcePath, join(targetRoot, normalizedEntry), { recursive: true });
}

const excludedPackage = process.env.SENPI_SIDECAR_EXCLUDE;
const copiedPackages = new Set();
const pendingPackages = Object.keys(manifest.dependencies ?? {}).map((packageName) => [
	packageName,
	manifestPath,
]);

function resolvePackageManifest(packageName, requiringManifestPath) {
	const requiringRoot = dirname(requiringManifestPath);
	for (
		let parentRoot = requiringRoot;
		parentRoot !== parse(parentRoot).root;
		parentRoot = dirname(parentRoot)
	) {
		const candidate = join(parentRoot, "node_modules", packageName, "package.json");
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

while (pendingPackages.length > 0) {
	const [packageName, requiringManifestPath] = pendingPackages.pop();
	if (HOST_PROVIDED_MODULES.has(packageName) || copiedPackages.has(packageName)) {
		continue;
	}
	copiedPackages.add(packageName);
	if (packageName === excludedPackage) {
		continue;
	}

	let packageManifestPath;
	try {
		packageManifestPath = createRequire(requiringManifestPath).resolve(`${packageName}/package.json`);
	} catch (error) {
		if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") {
			throw new Error(`Unable to resolve codemode sidecar dependency ${packageName}`, { cause: error });
		}
		packageManifestPath = resolvePackageManifest(packageName, requiringManifestPath);
		if (!packageManifestPath) {
			throw new Error(`Unable to resolve codemode sidecar dependency ${packageName}`, { cause: error });
		}
	}
	const packageManifest = JSON.parse(readFileSync(packageManifestPath, "utf8"));
	const packageRoot = dirname(packageManifestPath);
	cpSync(packageRoot, join(sidecarNodeModulesRoot, packageName), { recursive: true });
	for (const dependencyName of Object.keys(packageManifest.dependencies ?? {})) {
		pendingPackages.push([dependencyName, packageManifestPath]);
	}
}

console.log(
	`[copy-codemode-sidecar] copied ${manifest.files.length} entries and ${copiedPackages.size} runtime packages to ${targetRoot}`,
);
