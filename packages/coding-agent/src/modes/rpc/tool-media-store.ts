import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { assertValidSessionId } from "../../core/session-manager.ts";
import { base64ByteLength, type MediaPersister, type PersistedMedia } from "./media-placeholders.ts";

/**
 * Where a session keeps the images its tools produced.
 *
 * A `media_placeholders` client never receives the bytes on the socket. The host writes them
 * here, once, BEFORE the placeholder that names the file is emitted, so a client can render the
 * picture from the path whenever it likes: after a disconnect, an idle shutdown or a generation
 * handover, because the files outlive every connection. The directory sits next to the session
 * files, never under the user's project, and is removed with the durable session.
 */
export interface ToolMediaScope {
	readonly sessionDir: string;
	readonly durableSessionId: string;
}

export const MAX_TOOL_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_SESSION_MEDIA_BYTES = 256 * 1024 * 1024;

export interface ToolMediaLimits {
	readonly perImage: number;
	readonly perSession: number;
}

const DEFAULT_LIMITS: ToolMediaLimits = { perImage: MAX_TOOL_IMAGE_BYTES, perSession: MAX_SESSION_MEDIA_BYTES };

const MEDIA_DIRECTORY = "media";
const EXTENSIONS: Readonly<Record<string, string>> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
};

/** Bytes already stored per media root: the reservation every concurrent write is checked against. */
const reserved = new Map<string, number>();
/** Outcomes per live image block, so re-emitting a record (`get_messages`, `turn_end`) never rehashes it. */
const outcomes = new WeakMap<object, PersistedMedia>();

export function toolMediaRoot(scope: ToolMediaScope): string {
	assertValidSessionId(scope.durableSessionId);
	return join(scope.sessionDir, MEDIA_DIRECTORY, scope.durableSessionId);
}

function directoryBytes(directory: string): number {
	let total = 0;
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		total += entry.isDirectory() ? directoryBytes(path) : statSync(path).size;
	}
	return total;
}

function storedBytes(root: string): number {
	const known = reserved.get(root);
	if (known !== undefined) return known;
	const scanned = existsSync(root) ? directoryBytes(root) : 0;
	reserved.set(root, scanned);
	return scanned;
}

const unavailable = (reason: "image_too_large" | "session_limit" | "storage_error"): PersistedMedia => ({
	unavailableReason: reason,
});

function writeImage(path: string, bytes: Buffer): void {
	mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
	const staging = `${path}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		writeFileSync(staging, bytes, { mode: 0o600, flag: "wx" });
		renameSync(staging, path);
		chmodSync(path, 0o400);
	} catch (cause) {
		rmSync(staging, { force: true });
		throw cause;
	}
}

/**
 * Persist one tool-result image and report where it lives, or why it does not.
 *
 * Layout: `<sessionDir>/media/<durableSessionId>/<sha256(toolCallId)>/<contentIndex>-<sha256(bytes)>.<ext>`.
 * The content hash makes a file immutable and a repeat a no-op; the per-image and per-session
 * limits reject new storage and never evict a file a transcript may still reference.
 */
export function persistToolImage(
	scope: ToolMediaScope,
	ref: { readonly toolCallId: string; readonly contentIndex: number },
	block: { readonly data: string; readonly mimeType?: string },
	limits: ToolMediaLimits = DEFAULT_LIMITS,
): PersistedMedia {
	const known = outcomes.get(block);
	if (known !== undefined) return known;
	const outcome = store(scope, ref, block, limits);
	if (!("unavailableReason" in outcome) || outcome.unavailableReason !== "storage_error") outcomes.set(block, outcome);
	return outcome;
}

function store(
	scope: ToolMediaScope,
	ref: { readonly toolCallId: string; readonly contentIndex: number },
	block: { readonly data: string; readonly mimeType?: string },
	limits: ToolMediaLimits,
): PersistedMedia {
	const extension = EXTENSIONS[(block.mimeType ?? "").toLowerCase()];
	if (extension === undefined) return unavailable("storage_error");
	if (base64ByteLength(block.data) > limits.perImage) return unavailable("image_too_large");
	const bytes = Buffer.from(block.data, "base64");
	if (bytes.length > limits.perImage) return unavailable("image_too_large");
	try {
		const root = toolMediaRoot(scope);
		const callDirectory = createHash("sha256").update(ref.toolCallId).digest("hex");
		const digest = createHash("sha256").update(bytes).digest("hex");
		const path = resolve(root, callDirectory, `${ref.contentIndex}-${digest}.${extension}`);
		if (existsSync(path)) return { path };
		const used = storedBytes(root);
		if (used + bytes.length > limits.perSession) return unavailable("session_limit");
		reserved.set(root, used + bytes.length);
		try {
			writeImage(path, bytes);
		} catch (cause) {
			reserved.set(root, storedBytes(root) - bytes.length);
			throw cause;
		}
		return { path };
	} catch {
		return unavailable("storage_error");
	}
}

export function toolMediaPersister(scope: () => ToolMediaScope | undefined): MediaPersister {
	return (ref, block) => {
		const current = scope();
		return current === undefined ? undefined : persistToolImage(current, ref, block);
	};
}

export function removeToolMedia(scope: ToolMediaScope): void {
	const root = toolMediaRoot(scope);
	reserved.delete(root);
	rmSync(root, { recursive: true, force: true });
}

/** The media scope of the session stored in `sessionFile`; a file with no readable header has none. */
export async function toolMediaScopeOfSessionFile(sessionFile: string): Promise<ToolMediaScope | undefined> {
	try {
		const handle = await open(sessionFile, "r");
		try {
			const { buffer, bytesRead } = await handle.read(Buffer.alloc(4096), 0, 4096, 0);
			const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0] ?? "";
			const id = (JSON.parse(firstLine) as { id?: unknown }).id;
			return typeof id === "string" ? { sessionDir: dirname(sessionFile), durableSessionId: id } : undefined;
		} finally {
			await handle.close();
		}
	} catch {
		return undefined;
	}
}
