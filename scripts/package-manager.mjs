#!/usr/bin/env node
// Shared package-manager plumbing for the root orchestration scripts.
//
// Root scripts are launched by whichever package manager the contributor uses
// (`npm run`, `bun run`, `pnpm run`), and every child they spawn must use that
// same manager: hardcoding `npm` under bun or pnpm makes the child inherit
// cross-PM `npm_config_*` env vars (a wall of `npm warn Unknown env config`
// noise) and silently changes which runtime executes the workspace script.
// `build-all.mjs` and `run-workspaces.mjs` both route through this module so
// detection and spawning live in exactly one place.

import { spawn } from "node:child_process";
import { basename } from "node:path";

export const SUPPORTED_PACKAGE_MANAGERS = ["npm", "bun", "pnpm"];

export function detectPackageManager(env = process.env, forcedPm) {
	if (forcedPm) return { cmd: forcedPm, execpath: undefined };

	// The user agent names the manager outright (`bun/1.4.0 ...`, `pnpm/10.32.1 ...`,
	// `npm/11.19.0 ...`). The execpath is only a fallback and is judged by its
	// basename: a pnpm installed through `bun install -g` lives under ~/.bun/bin,
	// so matching "bun" anywhere in the path would misreport it.
	const execpath = env.npm_execpath;
	const userAgent = env.npm_config_user_agent ?? "";
	const fromUserAgent = SUPPORTED_PACKAGE_MANAGERS.find((name) => userAgent.startsWith(`${name}/`));
	const executable = execpath ? basename(execpath).toLowerCase() : "";
	let fromExecpath;
	if (/^bun(\.exe)?$/.test(executable)) fromExecpath = "bun";
	else if (/pnpm/.test(executable)) fromExecpath = "pnpm";
	else if (execpath) fromExecpath = "npm";

	return { cmd: fromUserAgent ?? fromExecpath ?? "npm", execpath };
}

export function cleanEnv(envSource = process.env) {
	// pnpm exports every .npmrc key as a lowercased npm_config_* env var and
	// normalizes dashes to underscores. When the parent is pnpm and the
	// child is npm (e.g. one of these builds still shells out to npm
	// internally), npm warns for each unknown key. Strip the keys that
	// only pnpm understands before spawning children so the output
	// stays clean regardless of PM.
	const PNPM_ONLY_KEYS = new Set([
		"node_linker",
		"link_workspace_packages",
		"prefer_workspace_packages",
		"verify_deps_before_run",
		"_jsr_registry",
		"npm_globalconfig",
	]);
	const env = { ...envSource };
	for (const key of Object.keys(env)) {
		const lower = key.toLowerCase();
		if (!lower.startsWith("npm_config_")) continue;
		const stripped = lower.slice("npm_config_".length);
		if (PNPM_ONLY_KEYS.has(stripped)) delete env[key];
	}
	return env;
}

/**
 * Resolves the executable and argv for a package-manager invocation.
 *
 * bun's execpath is a native binary, so it is invoked directly. npm's and
 * pnpm's execpaths are .js / .cjs entry points that have to be loaded through
 * the current Node runtime, unless they are native binaries (like pnpm.exe).
 * Without an execpath the manager is resolved by name on PATH.
 */
export function packageManagerInvocation(pm, args) {
	if (pm.execpath && (pm.cmd === "bun" || !/\.[cm]?js$/i.test(pm.execpath))) {
		return { command: pm.execpath, args };
	}
	if (pm.execpath) {
		return { command: process.execPath, args: [pm.execpath, ...args] };
	}
	return { command: pm.cmd, args };
}

/**
 * argv for `<pm> run <script>` with caller arguments. npm and bun consume the
 * first `--` and forward what follows to the script; pnpm forwards everything
 * after the script name verbatim, separator included, so it must not receive
 * one (measured on npm 11, bun 1.4, pnpm 10).
 */
export function runScriptArguments(pm, script, forwarded = []) {
	if (forwarded.length === 0) return ["run", script];
	return pm.cmd === "pnpm" ? ["run", script, ...forwarded] : ["run", script, "--", ...forwarded];
}

/**
 * Spawns `<pm> <args>` in `cwd` with inherited stdio and resolves with the exit
 * status (1 when the child died on a signal or could not be spawned at all).
 */
export function spawnPackageManager(pm, args, { cwd, env, label }) {
	const invocation = packageManagerInvocation(pm, args);
	return new Promise((resolve) => {
		const child = spawn(invocation.command, invocation.args, { cwd, stdio: "inherit", env, shell: false });
		child.on("error", (error) => {
			console.error(`\n[${label}] failed to spawn ${pm.cmd}: ${error.message}`);
			resolve(1);
		});
		child.on("close", (status) => resolve(status ?? 1));
	});
}
