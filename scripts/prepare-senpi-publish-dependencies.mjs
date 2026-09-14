#!/usr/bin/env node
// Stages the registry runtime closure of packages/coding-agent/publish-deps.lock.json into
// packages/coding-agent/node_modules so the packed tarball is self-contained. The staged
// tree mirrors the manifest exactly, whatever layout the developer's package manager
// produced: every node_modules/... entry (top-level AND nested) lands at its manifest path
// with the manifest version, and anything the manifest does not list is pruned.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

// "node_modules/a/node_modules/@s/b" -> ["a", "@s/b"]. Anything that is not a chain of
// package directories (the root "", workspace paths, dot entries) yields undefined.
export function lockPathPackageChain(lockPath) {
	const parts = lockPath.split("/");
	const chain = [];
	let index = 0;
	while (index < parts.length) {
		if (parts[index] !== "node_modules") return undefined;
		const name = parts[index + 1];
		if (!name || name.startsWith(".")) return undefined;
		if (name.startsWith("@")) {
			const scopedName = parts[index + 2];
			if (!scopedName) return undefined;
			chain.push(`${name}/${scopedName}`);
			index += 3;
		} else {
			chain.push(name);
			index += 2;
		}
	}
	return chain.length > 0 ? chain : undefined;
}

function chainLockPath(chain) {
	return chain.map((name) => `node_modules/${name}`).join("/");
}

function listPackageDirectories(nodeModulesDir) {
	const packages = [];
	if (!existsSync(nodeModulesDir)) return packages;
	for (const entry of readdirSync(nodeModulesDir, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		if (entry.name.startsWith("@")) {
			const scopeDir = join(nodeModulesDir, entry.name);
			for (const scoped of readdirSync(scopeDir, { withFileTypes: true })) {
				if (scoped.isDirectory()) packages.push({ name: `${entry.name}/${scoped.name}`, path: join(scopeDir, scoped.name) });
			}
			continue;
		}
		packages.push({ name: entry.name, path: join(nodeModulesDir, entry.name) });
	}
	return packages;
}

function installedPackageMatches(packageDir, entry) {
	let installed;
	try {
		installed = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
	} catch {
		return false;
	}
	return typeof entry?.version !== "string" || installed.version === entry.version;
}

// The manifest is npm's standalone tree for coding-agent, while the developer's install is
// laid out by whichever package manager ran (bun hoists a workspace install by its own
// rules). A manifest entry may therefore sit at the same nesting under the root install, be
// hoisted to the root, be staged in place already (materialized optionals), or be nested
// under some other dependent. Take the first installed copy whose version matches the
// manifest; a copy of another version is never a substitute.
function locateInstalledPackage(repoRoot, chain, entry, targetPath) {
	const rootNodeModules = join(repoRoot, "node_modules");
	const name = chain[chain.length - 1];
	for (const candidate of [join(repoRoot, chainLockPath(chain)), join(rootNodeModules, name), targetPath]) {
		if (installedPackageMatches(candidate, entry)) return candidate;
	}
	const pending = [rootNodeModules];
	while (pending.length > 0) {
		const nodeModulesDir = pending.pop();
		const candidate = join(nodeModulesDir, name);
		if (installedPackageMatches(candidate, entry)) return candidate;
		for (const { path } of listPackageDirectories(nodeModulesDir)) {
			const nested = join(path, "node_modules");
			if (existsSync(nested)) pending.push(nested);
		}
	}
	return undefined;
}

// Anything in the staged tree that the manifest does not list is a leftover from an earlier
// dependency graph (or an installer-specific nesting) and would otherwise be packed and
// shadow the manifest's resolution. Internal workspaces are re-staged by
// prepareSenpiBundledWorkspaces and are left alone here.
function pruneUnlistedPackages(nodeModulesDir, manifestLockPaths, internalPackageNames, lockPrefix = "node_modules") {
	for (const { name, path } of listPackageDirectories(nodeModulesDir)) {
		if (lockPrefix === "node_modules" && internalPackageNames.has(name)) continue;
		const lockPath = `${lockPrefix}/${name}`;
		if (!manifestLockPaths.has(lockPath)) {
			rmSync(path, { recursive: true, force: true });
			continue;
		}
		pruneUnlistedPackages(join(path, "node_modules"), manifestLockPaths, internalPackageNames, `${lockPath}/node_modules`);
	}
	if (!existsSync(nodeModulesDir)) return;
	for (const entry of readdirSync(nodeModulesDir, { withFileTypes: true })) {
		if (!entry.isDirectory() || !entry.name.startsWith("@")) continue;
		const scopeDir = join(nodeModulesDir, entry.name);
		if (readdirSync(scopeDir).length === 0) rmSync(scopeDir, { recursive: true, force: true });
	}
}

export function stagePublishDependencies(repoRoot, internalPackageNames) {
	// Staging manifest for the bundled publish tree. NOT npm-shrinkwrap.json: shipping a
	// file named npm-shrinkwrap.json breaks bundleDependencies installs (see the guard in
	// assertSenpiPackedWorkspaceFiles). Generated by generate-coding-agent-shrinkwrap.mjs.
	const manifestPath = join(repoRoot, "packages/coding-agent/publish-deps.lock.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const codingAgentDir = join(repoRoot, "packages/coding-agent");
	const codingAgentNodeModules = join(codingAgentDir, "node_modules");

	// Parents are staged before their nested entries (depth order) so a nested copy lands
	// inside the freshly copied parent instead of being wiped by it.
	const stagedEntries = [];
	for (const [lockPath, entry] of Object.entries(manifest.packages ?? {})) {
		const chain = lockPathPackageChain(lockPath);
		if (!chain || internalPackageNames.has(chain[0])) continue;
		stagedEntries.push({ lockPath, chain, entry });
	}
	stagedEntries.sort((a, b) => a.chain.length - b.chain.length || a.lockPath.localeCompare(b.lockPath));

	pruneUnlistedPackages(codingAgentNodeModules, new Set(stagedEntries.map(({ lockPath }) => lockPath)), internalPackageNames);

	for (const { lockPath, chain, entry } of stagedEntries) {
		const optional = entry && typeof entry === "object" && entry.optional === true;
		const targetPath = join(codingAgentDir, lockPath);
		if (chain.length > 1 && !existsSync(join(codingAgentDir, chainLockPath(chain.slice(0, -1)), "package.json"))) {
			// The parent was optional and absent; its nested closure is absent with it.
			if (optional) continue;
			throw new Error(`Missing staged parent for ${lockPath}. Run npm install before publishing.`);
		}

		const sourcePath = locateInstalledPackage(repoRoot, chain, entry, targetPath);
		if (sourcePath === undefined) {
			if (optional) continue;
			const expected = typeof entry?.version === "string" ? `@${entry.version}` : "";
			throw new Error(
				`Missing ${join(repoRoot, "node_modules", chain[chain.length - 1])}${expected} for ${lockPath}. Run npm install before publishing.`,
			);
		}
		if (sourcePath === targetPath) continue;

		rmSync(targetPath, { recursive: true, force: true });
		mkdirSync(dirname(targetPath), { recursive: true });
		cpSync(sourcePath, targetPath, { recursive: true });
	}

	return manifest;
}
