import { createHash } from "node:crypto";
import { glob, readFile, readdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { GateInputError } from "./gate-input-error.ts";

const manifestSchema = Type.Object({ main: Type.Optional(Type.String()) });
export const fingerprintSchema = Type.Record(Type.String(), Type.String());

export async function builtWorkspaces(target: string) {
	const root = resolve(target, "../..");
	const workspaces: { readonly directory: string; readonly label: string; readonly entry: string }[] = [];
	for await (const path of glob("packages/*/package.json", { cwd: root })) {
		const manifest: unknown = JSON.parse(await readFile(resolve(root, path), "utf8"));
		if (!Check(manifestSchema, manifest)) throw new GateInputError(path);
		if (!manifest.main?.replace(/^\.\//u, "").startsWith("dist/")) continue;
		const directory = resolve(root, path, "..");
		workspaces.push({
			directory, label: relative(root, directory).replaceAll("\\", "/"),
			entry: resolve(directory, manifest.main),
		});
	}
	return workspaces;
}

export async function buildFingerprint(workspace: string): Promise<Record<string, string>> {
	const names = ["package.json", ...(await readdir(workspace)).filter((name) => /^tsconfig.*\.json$/u.test(name))];
	for (const entry of await readdir(resolve(workspace, "src"), { recursive: true, withFileTypes: true })) {
		if (entry.isFile()) names.push(relative(workspace, resolve(entry.parentPath, entry.name)).replaceAll("\\", "/"));
	}
	const files: Record<string, string> = {};
	for (const name of names.sort()) {
		files[name] = createHash("sha256").update(await readFile(resolve(workspace, name))).digest("hex");
	}
	return files;
}

/** Called only by the successful build wrapper, never inferred during preflight. */
export async function recordTargetBuild(target: string): Promise<void> {
	for (const workspace of await builtWorkspaces(target)) {
		await readFile(workspace.entry);
		await writeFile(resolve(workspace.directory, "dist/.senpi-gate-inputs.json"),
			`${JSON.stringify(await buildFingerprint(workspace.directory), null, 2)}\n`);
	}
}
