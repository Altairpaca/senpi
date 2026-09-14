import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "../../../config.ts";
import { GrepEngineError, type GrepEngine } from "./engine.ts";

export interface GrepEngineSelectorOptions {
	env?: NodeJS.ProcessEnv;
	packageDir?: string;
	execPath?: string;
}

let singleton: Promise<GrepEngine> | undefined;

export function resolveGrepEngine(options: GrepEngineSelectorOptions = {}): Promise<GrepEngine> {
	if (!options.env && !options.packageDir && !options.execPath && singleton) return singleton;
	const promise = selectEngine(options);
	if (!options.env && !options.packageDir && !options.execPath) singleton = promise;
	return promise;
}

async function selectEngine(options: GrepEngineSelectorOptions): Promise<GrepEngine> {
	const env = options.env ?? process.env;
	const requested = env.SENPI_GREP_ENGINE ?? "auto";
	if (requested !== "auto" && requested !== "rg" && requested !== "native") {
		throw new GrepEngineError("ENGINE_UNAVAILABLE", `Unknown SENPI_GREP_ENGINE value: ${requested}`);
	}
	if (requested === "rg") return loadRgEngine();
	if (requested === "native") return loadNativeEngine(options, env);
	try {
		return await loadNativeEngine(options, env);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[grep] native engine unavailable; falling back to rg: ${message}`);
		return loadRgEngine();
	}
}

async function loadRgEngine(): Promise<GrepEngine> {
	const module = await import("./rg-engine.ts");
	return module.createRgEngine();
}

async function loadNativeEngine(options: GrepEngineSelectorOptions, env: NodeJS.ProcessEnv): Promise<GrepEngine> {
	const module = await import("./native-engine.ts");
	const packageDir = options.packageDir ?? getPackageDir();
	const execDir = dirname(options.execPath ?? process.execPath);
	const host = `${process.platform}-${process.arch}`;
	const candidates = env.SENPI_GREP_NATIVE_PATH
		? [env.SENPI_GREP_NATIVE_PATH]
		: [join(packageDir, "native", "prebuilds", host, `senpi_grep.${host}.node`), join(execDir, "native", "prebuilds", host, `senpi_grep.${host}.node`)];
	const candidate = candidates.find((path) => existsSync(path));
	if (!candidate) throw new GrepEngineError("ENGINE_UNAVAILABLE", `No native grep prebuild available; tried ${candidates.join(", ")}`);
	try {
		const binding = createRequire(import.meta.url)(candidate) as Record<string, unknown>;
		if (typeof binding.__senpiGrepAbi1 !== "function") throw new Error("native grep sentinel mismatch");
		return module.createNativeEngine(binding);
	} catch (error) {
		throw new GrepEngineError("ENGINE_UNAVAILABLE", `Unable to load native grep engine: ${String(error)}`);
	}
}

export function resetGrepEngineForTests(): void { singleton = undefined; }
