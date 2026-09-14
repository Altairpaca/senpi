import { type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio, spawn } from "node:child_process";
import { open, realpath, stat } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { ensureTool } from "../../../utils/tools-manager.ts";
import {
	type GrepEngine,
	GrepEngineError,
	type GrepEngineMatch,
	type GrepEngineRequest,
	type GrepEngineResult,
} from "./engine.ts";

const MAX_FILE_BYTES = 4_194_304;
const CAPPED_BATCH_SIZE = 200;
const pathOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
const slashPath = (path: string): string => path.split(sep).join("/");

export interface RgEngineOptions {
	/** Process and clock seams keep cancellation and ordered-deadline tests event-driven. */
	spawn?: (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
	now?: () => number;
}

interface Root {
	path: string;
	alias: string;
	cwd: string;
}
interface Candidate {
	absolute: string;
	canonical: string;
	display: string;
	root: Root;
	size: number;
}
interface RgText {
	text?: string;
	bytes?: string;
}
interface RgEvent {
	type: "begin" | "match" | "context" | "end" | "summary";
	data: {
		path?: RgText;
		lines?: RgText;
		line_number?: number;
		submatches?: Array<{ start: number }>;
		binary_offset?: number | null;
	};
}
interface FileRows {
	candidate: Candidate;
	rows: Map<number, GrepEngineMatch>;
}
class SearchTimeout extends Error {}

function decode(value: RgText | undefined): string {
	if (typeof value?.text === "string") return value.text;
	if (typeof value?.bytes === "string") return Buffer.from(value.bytes, "base64").toString("utf8");
	throw new GrepEngineError("ENGINE_UNAVAILABLE", "Invalid ripgrep JSON text/bytes field");
}

function walkerFlags(request: GrepEngineRequest): string[] {
	const args: string[] = [];
	if (request.hidden ?? true) args.push("--hidden");
	if (!(request.gitignore ?? true)) args.push("--no-ignore");
	else args.push("--no-require-git");
	// The contract makes exclusions win regardless of their position in the request.
	for (const glob of request.glob?.filter((glob) => !glob.startsWith("!")) ?? []) args.push("-g", glob);
	for (const glob of request.glob?.filter((glob) => glob.startsWith("!")) ?? []) args.push("-g", glob);
	if (request.type) args.push("--type", request.type);
	if (request.hidden ?? true) args.push("-g", "!.git");
	return args;
}

function matcherFlags(request: GrepEngineRequest): string[] {
	// Disable BOM-driven transcoding: the frozen contract searches bytes, not decoded UTF-16.
	const args = ["--json", "--line-number", "--color=never", "--encoding", "none"];
	if (request.ignoreCase) args.push("-i");
	if (request.literal) args.push("-F");
	if (request.multiline) args.push("-U");
	if (request.contextBefore !== undefined) args.push("-B", String(request.contextBefore));
	if (request.contextAfter !== undefined) args.push("-A", String(request.contextAfter));
	if (request.pcre2) args.push("--pcre2");
	if (request.mode === "files") args.push("-m", "1");
	else if (
		(request.mode ?? "content") === "content" &&
		request.maxCountPerFile !== undefined &&
		request.lineStart === undefined &&
		request.lineEnd === undefined
	)
		args.push("-m", String(request.maxCountPerFile + 1));
	return args;
}

function rgError(message: string): GrepEngineError {
	if (/look-around|backreference/i.test(message)) return new GrepEngineError("UNSUPPORTED_REGEX", message);
	if (/regex parse error|PCRE2: error compiling pattern|the literal .* is not allowed in a regex/i.test(message))
		return new GrepEngineError("INVALID_PATTERN", message);
	if (/error parsing glob/i.test(message)) return new GrepEngineError("INVALID_GLOB", message);
	if (/unrecognized file type|unknown file type/i.test(message)) return new GrepEngineError("UNKNOWN_TYPE", message);
	return new GrepEngineError("ENGINE_UNAVAILABLE", message);
}

function onlyNoFilesWarnings(stderr: string): boolean {
	const lines = stderr.trim().split(/\r?\n/);
	return (
		lines.some((line) => line.startsWith("No files were searched")) &&
		lines.every(
			(line) =>
				line.startsWith("No files were searched") ||
				line === "Running with --debug will show why files are being skipped.",
		)
	);
}

/** A recursive rg walk per ordered segment, never a second implementation of ignore rules. */
export class RgGrepEngine implements GrepEngine {
	readonly name = "rg" as const;
	private readonly launch: NonNullable<RgEngineOptions["spawn"]>;
	private readonly now: () => number;

	constructor(options: RgEngineOptions = {}) {
		this.launch = options.spawn ?? spawn;
		this.now = options.now ?? Date.now;
	}

	async search(request: GrepEngineRequest, signal?: AbortSignal): Promise<GrepEngineResult> {
		const started = this.now();
		const deadline = started + (request.timeoutMs ?? 30_000);
		const result: GrepEngineResult = {
			matches: [],
			fileCounts: [],
			counts: { matches: request.mode === "files" ? null : 0, files: 0, exact: true },
			filesSearched: 0,
			limitReached: false,
			perFileLimitReached: false,
			skippedOversized: 0,
			prefixSearched: 0,
			skippedBinary: 0,
			missingPaths: [],
			warnings: [],
			timedOut: false,
			elapsedMs: 0,
			effectivePattern: request.pattern,
			patternKind: request.literal ? "literal" : "regex",
			regexEngine: request.pcre2 ? "pcre2" : "rust",
		};
		const check = () => {
			if (signal?.aborted) throw new GrepEngineError("ABORTED", "Grep search aborted");
			if (this.now() >= deadline) throw new SearchTimeout();
		};
		try {
			check();
			const roots: Root[] = [];
			for (const path of new Set(request.paths)) {
				try {
					const [info, canonical] = await Promise.all([stat(path), realpath(path)]);
					// Anchored rg globs use the OS cwd (canonical even for /var aliases on macOS).
					roots.push({ path: canonical, alias: path, cwd: info.isDirectory() ? canonical : dirname(canonical) });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					result.missingPaths.push(path);
				}
			}
			if (roots.length === 0)
				throw new GrepEngineError("PATH_NOT_FOUND", `No search paths exist: ${request.paths.join(", ")}`);
			check();
			const executable = await ensureTool("rg");
			if (!executable)
				throw new GrepEngineError("ENGINE_UNAVAILABLE", "ripgrep is unavailable and could not be downloaded");
			const walk = walkerFlags(request);
			const matcher = matcherFlags(request);
			const run = async (
				args: string[],
				cwd: string,
				onEvent?: (event: RgEvent) => void,
				input?: Buffer,
			): Promise<Buffer> => {
				check();
				return new Promise<Buffer>((resolveRun, reject) => {
					const child = this.launch(executable, args, { cwd, stdio: "pipe" });
					const chunks: Buffer[] = [];
					let stderr = "";
					let failure: Error | undefined;
					let timedOut = false;
					const stop = () => {
						if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
					};
					const onAbort = () => {
						stop();
					};
					const timer = setTimeout(
						() => {
							timedOut = true;
							stop();
						},
						Math.max(0, deadline - this.now()),
					);
					signal?.addEventListener("abort", onAbort, { once: true });
					const lines = onEvent ? createInterface({ input: child.stdout }) : undefined;
					lines?.on("line", (line) => {
						if (failure) return;
						try {
							const event = JSON.parse(line) as RgEvent;
							if (!event || !["begin", "match", "context", "end", "summary"].includes(event.type) || !event.data)
								throw new Error("Invalid ripgrep JSON event");
							onEvent?.(event);
						} catch (error) {
							failure = new GrepEngineError("ENGINE_UNAVAILABLE", `Malformed ripgrep JSON: ${String(error)}`);
							stop();
						}
					});
					if (!onEvent) child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
					child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
						stderr += chunk;
					});
					child.on("error", (error) => {
						failure = new GrepEngineError("ENGINE_UNAVAILABLE", `Failed to run ripgrep: ${error.message}`);
					});
					child.stdin.on("error", (error: NodeJS.ErrnoException) => {
						// rg can stop reading stdin at -m before the prefix has finished writing.
						if (error.code === "EPIPE") return;
						failure = new GrepEngineError(
							"ENGINE_UNAVAILABLE",
							`Failed to write ripgrep input: ${error.message}`,
						);
						stop();
					});
					child.on("close", (code) => {
						clearTimeout(timer);
						lines?.close();
						signal?.removeEventListener("abort", onAbort);
						if (signal?.aborted) reject(new GrepEngineError("ABORTED", "Grep search aborted"));
						else if (timedOut || this.now() >= deadline) reject(new SearchTimeout());
						else if (failure) reject(failure);
						else if (code !== 0 && code !== 1 && !(code === 2 && onlyNoFilesWarnings(stderr)))
							reject(rgError(stderr.trim() || `ripgrep exited with code ${code}`));
						else resolveRun(Buffer.concat(chunks));
					});
					if (input !== undefined) child.stdin.end(input);
					if (signal?.aborted) onAbort();
				});
			};

			const candidates = new Map<string, Candidate>();
			for (const root of roots) {
				const output = await run(["--files", "--null", "--sort", "path", ...walk, "--", root.path], root.cwd);
				for (const path of output.toString("utf8").split("\0").filter(Boolean)) {
					check();
					const absolute = resolve(root.cwd, path);
					const [canonical, info] = await Promise.all([realpath(absolute), stat(absolute)]);
					const alias = resolve(root.alias, relative(root.path, absolute));
					const display = slashPath(relative(request.cwd, alias)) || basename(alias);
					const existing = candidates.get(canonical);
					if (!existing || pathOrder(display, existing.display) < 0)
						candidates.set(canonical, { absolute, canonical, display, root, size: info.size });
				}
			}
			result.filesSearched = candidates.size;
			const binaryPaths = new Set<string>();
			// Scan the entire normal-size file, including NULs after rg's first search buffer.
			for (const root of roots) {
				const output = await run(
					[
						"-a",
						"-l",
						"--null",
						"--sort",
						"path",
						"--encoding",
						"none",
						"--max-filesize",
						String(MAX_FILE_BYTES),
						...walk,
						"-e",
						"\\x00",
						"--",
						root.path,
					],
					root.cwd,
				);
				for (const path of output.toString("utf8").split("\0").filter(Boolean))
					binaryPaths.add(await realpath(resolve(root.cwd, path)));
			}
			result.skippedBinary = [...binaryPaths].filter((path) => candidates.has(path)).length;
			const ordered = [...candidates.values()]
				.filter((candidate) => !binaryPaths.has(candidate.canonical))
				.sort((a, b) => pathOrder(a.display, b.display));
			const segments: Candidate[][] = [];
			for (const candidate of ordered) {
				const previous = segments.at(-1);
				if (
					candidate.size <= MAX_FILE_BYTES &&
					previous &&
					previous[0].size <= MAX_FILE_BYTES &&
					previous[0].root === candidate.root &&
					(request.maxCount === undefined || previous.length < CAPPED_BATCH_SIZE)
				)
					previous.push(candidate);
				else segments.push([candidate]);
			}

			let matcherRan = false;
			for (const [segmentIndex, segment] of segments.entries()) {
				check();
				const first = segment[0];
				const oversized = first.size > MAX_FILE_BYTES;
				let prefix: Buffer | undefined;
				if (oversized) {
					try {
						const file = await open(first.absolute, "r");
						try {
							const buffer = Buffer.alloc(MAX_FILE_BYTES);
							let length = 0;
							while (length < buffer.length) {
								check();
								const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
								if (bytesRead === 0) break;
								length += bytesRead;
							}
							prefix = buffer.subarray(0, length);
						} finally {
							await file.close();
						}
					} catch (error) {
						if (error instanceof SearchTimeout || error instanceof GrepEngineError) throw error;
						check();
						result.skippedOversized++;
						result.warnings.push({ path: first.display, code: "SKIPPED_OVERSIZED", message: String(error) });
						continue;
					}
					check();
					// Inspect the full prefix BEFORE dropping its incomplete trailing line.
					if (prefix.indexOf(0) !== -1) {
						result.skippedBinary++;
						continue;
					}
					const newline = prefix.lastIndexOf(10);
					if (newline === -1) {
						result.skippedOversized++;
						continue;
					}
					prefix = prefix.subarray(0, newline + 1);
				}

				const files = new Map<string, FileRows>();
				const byPath = new Map(segment.map((candidate) => [candidate.absolute, candidate]));
				const segmentBinary = new Set<string>();
				const onEvent = (event: RgEvent) => {
					if (event.type === "summary") return;
					const candidate = oversized ? first : byPath.get(resolve(first.root.cwd, decode(event.data.path)));
					if (!candidate) throw new Error("ripgrep searched a file outside the ordered segment");
					if (event.type === "begin") {
						files.set(candidate.display, { candidate, rows: new Map() });
						return;
					}
					if (event.type === "end") {
						if (event.data.binary_offset != null) {
							files.delete(candidate.display);
							segmentBinary.add(candidate.display);
						}
						return;
					}
					const file = files.get(candidate.display);
					if (!file || typeof event.data.line_number !== "number")
						throw new Error("ripgrep match/context without a begin or line number");
					const text = decode(event.data.lines).replace(/\n$/, "").split("\n");
					for (const [index, physical] of text.entries()) {
						const line = event.data.line_number + index;
						if (line < (request.lineStart ?? 1) || line > (request.lineEnd ?? Infinity)) continue;
						const isContext = event.type === "context";
						const existing = file.rows.get(line);
						if (existing && (!existing.isContext || isContext)) continue;
						const column =
							!isContext && index === 0 && event.data.submatches?.[0]
								? event.data.submatches[0].start + 1
								: undefined;
						let content = physical.replace(/\r$/, "");
						let truncated = false;
						if (request.maxColumns !== undefined) {
							const scalars = Array.from(content);
							if (scalars.length > request.maxColumns) {
								content = `${scalars.slice(0, request.maxColumns).join("")}...`;
								truncated = true;
							}
						}
						file.rows.set(line, { path: candidate.display, line, column, text: content, isContext, truncated });
					}
				};
				matcherRan = true;
				if (oversized) await run([...matcher, "--", request.pattern], request.cwd, onEvent, prefix);
				else {
					// Original positive globs would otherwise OR with the include list. Reset file
					// admission, allow traversal, then whitelist precisely the enumerated segment.
					const includes = ["-g", "!**/*", "-g", "**/"];
					for (const candidate of segment)
						includes.push(
							"-g",
							`/${slashPath(relative(first.root.cwd, candidate.absolute)).replace(/[\\*?[\]{}!]/g, "\\$&")}`,
						);
					await run(
						[
							...matcher,
							"--sort",
							"path",
							"--max-filesize",
							String(MAX_FILE_BYTES),
							...walk,
							...includes,
							"--",
							request.pattern,
							first.root.path,
						],
						first.root.cwd,
						onEvent,
					);
				}
				check();
				// Nothing from a partially completed segment is visible before this point.
				if (oversized) result.prefixSearched++;
				result.skippedBinary += segmentBinary.size;
				const segmentFiles = [...files.values()].sort((a, b) =>
					pathOrder(a.candidate.display, b.candidate.display),
				);
				for (const file of segmentFiles) {
					const rows = [...file.rows.values()].sort(
						(a, b) => a.line - b.line || (a.column ?? 0) - (b.column ?? 0),
					);
					const matching = rows.filter((row) => !row.isContext);
					if (matching.length === 0) continue;
					const perFileCap = request.maxCountPerFile ?? Infinity;
					const perFileLimited = request.mode !== "files" && matching.length > perFileCap;
					result.perFileLimitReached ||= perFileLimited;
					const remaining = Math.max(
						0,
						(request.maxCount ?? Infinity) -
							(request.mode === "files" ? result.counts.files : (result.counts.matches ?? 0)),
					);
					const admitted = matching.slice(
						0,
						request.mode === "files" ? (remaining > 0 ? 1 : 0) : Math.min(perFileCap, remaining),
					);
					const available = request.mode === "files" ? 1 : Math.min(matching.length, perFileCap);
					if (admitted.length < available) result.limitReached = true;
					if (admitted.length === 0) continue;
					result.counts.files++;
					if (result.counts.matches !== null) result.counts.matches += admitted.length;
					if (request.mode === "count" || request.mode === "files")
						result.fileCounts.push({
							path: file.candidate.display,
							count: request.mode === "files" ? null : admitted.length,
							limitReached: perFileLimited,
						});
					else {
						const lines = new Set(admitted.map((row) => row.line));
						for (const row of rows) {
							if (
								lines.has(row.line) ||
								(row.isContext &&
									admitted.some(
										(match) =>
											row.line >= match.line - (request.contextBefore ?? 0) &&
											row.line <= match.line + (request.contextAfter ?? 0),
									))
							)
								result.matches.push(row);
						}
					}
				}
				const admittedCount = request.mode === "files" ? result.counts.files : (result.counts.matches ?? 0);
				if (request.maxCount !== undefined && admittedCount >= request.maxCount) {
					if (segmentIndex < segments.length - 1) result.limitReached = true;
					break;
				}
			}
			// An empty/all-skipped corpus must still report a malformed matcher, not a false no-match.
			if (!matcherRan) await run([...matcher, "--", request.pattern], request.cwd, () => {}, Buffer.alloc(0));
		} catch (error) {
			if (!(error instanceof SearchTimeout)) throw error;
			result.timedOut = true;
			result.warnings.push({
				code: "TIMED_OUT",
				message: `Timed out after ${request.timeoutMs ?? 30_000} ms; showing the completed ordered prefix.`,
			});
		}
		result.counts.exact = !result.limitReached && !result.perFileLimitReached && !result.timedOut;
		result.elapsedMs = Math.max(0, this.now() - started);
		return result;
	}
}

export function createRgEngine(options: RgEngineOptions = {}): GrepEngine {
	return new RgGrepEngine(options);
}
