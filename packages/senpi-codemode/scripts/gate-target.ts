import { glob, readFile, readdir, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { GateInputError } from "./gate-input-error.ts";

const manifestSchema = Type.Object({ main: Type.Optional(Type.String()) });

/** Workspace imports resolve through dist, not the source tree being compared. */
export async function assertFreshTarget(target: string): Promise<void> {
	const root = resolve(target, "../..");
	for await (const manifestPath of glob("packages/*/package.json", { cwd: root })) {
		const manifest: unknown = JSON.parse(await readFile(resolve(root, manifestPath), "utf8"));
		if (!Check(manifestSchema, manifest)) throw new GateInputError(manifestPath);
		if (!manifest.main?.replace(/^\.\//u, "").startsWith("dist/")) continue;
		const workspace = resolve(root, manifestPath, "..");
		const label = relative(root, workspace).replaceAll("\\", "/");
		const entry = await stat(resolve(workspace, manifest.main)).catch((error: unknown) => {
			if (error instanceof Error && "code" in error && error.code === "ENOENT")
				throw new GateInputError(`stale workspace dist: ${label} (missing build entry; run bun run build)`);
			throw error;
		});
		const inputs = [manifestPath, ...(await readdir(workspace)).filter((name) => /^tsconfig.*\.json$/u.test(name))
			.map((name) => `${label}/${name}`)];
		for (const source of await readdir(resolve(workspace, "src"), { recursive: true, withFileTypes: true })) {
			if (source.isFile()) inputs.push(relative(root, resolve(source.parentPath, source.name)));
		}
		for (const input of inputs) {
			if ((await stat(resolve(root, input))).mtimeMs > entry.mtimeMs)
				throw new GateInputError(`stale workspace dist: ${label} (${input} is newer than its build; run bun run build)`);
		}
	}
}
