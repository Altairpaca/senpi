import { readFileSync, realpathSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The Node build deliberately has no Bun dependency. This is the runtime-only
// subset of Bun's module plugin and single-entry build contracts.
type ModuleSource = { readonly contents: string; readonly loader: "ts" };
type ModuleObject = { readonly exports: Readonly<Record<string, unknown>>; readonly loader: "object" };
type Resolution = { readonly path: string; readonly namespace?: string; readonly external?: boolean };
type Constraints = { readonly filter: RegExp; readonly namespace?: string };
interface RuntimeModuleBuilder {
	module(name: string, load: () => ModuleObject): void;
	onResolve(
		options: Constraints,
		resolve: (args: {
			readonly path: string;
			readonly importer: string;
			readonly kind?: string;
		}) => Resolution | undefined,
	): void;
	onLoad(options: Constraints, load: (args: { readonly path: string }) => ModuleSource | Promise<ModuleSource>): void;
}
declare const Bun: {
	plugin(options: { readonly name: string; readonly setup: (builder: RuntimeModuleBuilder) => void }): void;
	resolveSync(specifier: string, directory: string): string;
	build(options: {
		readonly entrypoints: readonly [string];
		readonly target: "bun";
		readonly metafile: true;
		readonly write: false;
		readonly throw: true;
		readonly define: Readonly<Record<string, string>>;
		readonly banner: string;
		readonly plugins: readonly { readonly name: string; readonly setup: (builder: RuntimeModuleBuilder) => void }[];
	}): Promise<{
		readonly outputs: readonly [{ text(): Promise<string> }];
		readonly metafile: {
			readonly inputs: Readonly<Record<string, { readonly format?: string }>>;
			readonly outputs: Readonly<Record<string, { readonly exports: readonly string[] }>>;
		};
	}>;
};

type PreparedModule = { readonly source: ModuleSource; readonly dependencies: readonly string[] };
let nextGeneration = 0;

/** One namespace per load batch; old factories keep their own dynamic-import graph. */
export function createBunExtensionImporter(
	virtualModules: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
) {
	const namespace = `senpi-extension-${nextGeneration++}`;
	const modulePath = (path: string): string => encodeURIComponent(path);
	// Bun prefixes a slash on computed dynamic-import referrers, but not static ones.
	const referrerPrefix = new RegExp(`^/?${namespace}:`);
	const realPath = (id: string): string => decodeURIComponent(id.replace(referrerPrefix, ""));
	const sources = new Map<string, ModuleSource>();
	const transforms = new Map<string, Promise<PreparedModule>>();
	const commonJsDefaults = new Set<string>();
	const dynamicImports = new Map<string, { readonly specifier: string; readonly filename: string }>();
	const createModuleRequire = (filename: string) => {
		const nativeRequire = createRequire(filename);
		return (specifier: string): unknown => {
			if (referrerPrefix.test(specifier) && commonJsDefaults.has(realPath(specifier))) {
				// Bun emitted this CommonJS source as an ESM default export.
				const module: { readonly default: unknown } = nativeRequire(specifier);
				return module.default;
			}
			return nativeRequire(specifier);
		};
	};
	const resolveImport = (specifier: string, filename: string): Resolution => {
		if (Object.hasOwn(virtualModules, specifier) || isBuiltin(specifier) || specifier.startsWith("bun:")) {
			return { path: specifier, namespace: "file" };
		}
		const path = specifier.startsWith("file:") ? fileURLToPath(specifier) : specifier;
		const resolved = Bun.resolveSync(path, dirname(filename));
		return /\.[cm]?[jt]sx?$/.test(resolved)
			? { path: modulePath(resolved), namespace }
			: { path: pathToFileURL(resolved).href, namespace: "file" };
	};

	const transformFile = (filename: string): Promise<PreparedModule> => {
		const existing = transforms.get(filename);
		if (existing) return existing;
		const pending = (async (): Promise<PreparedModule> => {
			const source = readFileSync(filename, "utf8");
			// Keep real metadata separate from Bun's internal generation referrer.
			let metadataName = "__senpiExtensionMeta";
			while (source.includes(metadataName)) metadataName += "_";
			const metadata = JSON.stringify({ url: pathToFileURL(filename).href, path: filename, dir: dirname(filename) });
			const dependencies: string[] = [];
			// Runtime onResolve skips bare package names; the build resolver does not.
			// Externalize every edge so Bun still owns module instances and cycles.
			const options = {
				entrypoints: [filename],
				target: "bun",
				write: false,
				throw: true,
				metafile: true,
				define: { "import.meta": metadataName },
				banner: `import { createRequire as ${metadataName}Require } from "${namespace}:runtime";\nconst ${metadataName} = Object.assign(Object.create(import.meta), ${metadata}, { require: ${metadataName}Require(${JSON.stringify(filename)}) });`,
				plugins: [
					{
						name: namespace,
						setup(build) {
							build.onResolve({ filter: /.*/ }, (args) => {
								if (args.path === filename) return { path: filename };
								if (args.kind === "dynamic-import") {
									const id = `dynamic-${dynamicImports.size}`;
									dynamicImports.set(id, { specifier: args.path, filename });
									return { path: `${namespace}:${id}`, external: true };
								}
								const resolved = resolveImport(args.path, filename);
								if (resolved.namespace === namespace) dependencies.push(realPath(resolved.path));
								return {
									path: resolved.namespace === namespace ? `${namespace}:${resolved.path}` : resolved.path,
									external: true,
								};
							});
						},
					},
				],
			} satisfies Parameters<typeof Bun.build>[0];
			const transformed = await Bun.build(options);
			// Preserve CommonJS exports for native require(), using Bun's parsed
			// module format rather than guessing from filenames or source strings.
			// Dynamic CommonJS exports have no statically listed exports; Bun
			// emits their value through a synthesized ESM default export.
			if (
				Object.values(transformed.metafile.inputs).some((input) => input.format === "cjs") &&
				Object.values(transformed.metafile.outputs).some((output) => output.exports.length === 0)
			) {
				commonJsDefaults.add(filename);
			}
			const prepared: ModuleSource = { contents: await transformed.outputs[0].text(), loader: "ts" };
			sources.set(filename, prepared);
			return { source: prepared, dependencies };
		})();
		transforms.set(filename, pending);
		return pending;
	};

	const prepareGraph = async (filename: string): Promise<ModuleSource> => {
		const root = await transformFile(filename);
		const seen = new Set([filename]);
		const dependencies = [...root.dependencies];
		// Transform, but do not evaluate, static dependencies before the first
		// import. Synchronous require() hooks cannot return pending promises.
		for (const dependency of dependencies) {
			if (seen.has(dependency)) continue;
			seen.add(dependency);
			const prepared = await transformFile(dependency);
			dependencies.push(...prepared.dependencies);
		}
		return root.source;
	};

	Bun.plugin({
		name: namespace,
		setup(builder) {
			builder.module(`${namespace}:runtime`, () => ({
				exports: { createRequire: createModuleRequire },
				loader: "object",
			}));
			for (const [name, exports] of Object.entries(virtualModules)) {
				builder.module(name, () => ({ exports, loader: "object" }));
			}
			builder.onResolve({ filter: /.*/, namespace }, ({ path }) => {
				const deferred = dynamicImports.get(path);
				return deferred ? resolveImport(deferred.specifier, deferred.filename) : { path, namespace };
			});
			builder.onResolve({ filter: /.*/, namespace: "file" }, ({ path, importer }) => {
				if (!referrerPrefix.test(importer)) return undefined;
				return resolveImport(path, realPath(importer));
			});
			builder.onLoad({ filter: /.*/, namespace }, ({ path }) => {
				const filename = realPath(path);
				return sources.get(filename) ?? prepareGraph(filename);
			});
		},
	});

	return {
		async import(path: string, _options: { readonly default: true }): Promise<unknown> {
			const filename = realpathSync(resolve(path));
			await prepareGraph(filename);
			const id = `${namespace}:${modulePath(filename)}`;
			const module: { readonly default?: unknown } = await import(id);
			return module.default;
		},
	};
}
