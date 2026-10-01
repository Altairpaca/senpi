import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/pi-ai";
import { isSdkImageMediaType } from "./content-blocks.ts";

/**
 * Most distinct historical images one cold-seed / flatten replay re-sends (#2490).
 * The user's own uploads are kept first, then the most recently returned tool
 * images; every other historical image becomes a one-line note. The final user
 * message is not history and always carries its own images.
 */
export const MAX_REPLAYED_HISTORY_IMAGES = 8;

export type ReplayedImageOrigin =
	| { readonly kind: "user" }
	| { readonly kind: "tool"; readonly toolName: string; readonly toolCallId: string };

function subject(origin: ReplayedImageOrigin): string {
	return origin.kind === "user" ? "[image attached by the user" : `[image returned by the ${origin.toolName} tool`;
}

function source(origin: ReplayedImageOrigin): string {
	return origin.kind === "user"
		? "attached by the user"
		: `returned by the ${origin.toolName} tool, id=${origin.toolCallId}`;
}

export const coldSeedImageText = {
	toolOutput: (toolName: string): string =>
		`[image returned by the ${toolName} tool (tool output, not a user attachment)]`,
	duplicate: (origin: ReplayedImageOrigin, first: ReplayedImageOrigin): string =>
		`${subject(origin)}: identical to an image already shown above (${source(first)}); not attached again]`,
	capped: (origin: ReplayedImageOrigin): string =>
		`${subject(origin)}: omitted from this replay, which re-sends at most ${MAX_REPLAYED_HISTORY_IMAGES} earlier images; re-read the source if you need it]`,
	unreadable: (origin: ReplayedImageOrigin): string =>
		`${subject(origin)}: omitted because its image data is missing or unreadable]`,
} as const;

type ImageOccurrence = {
	readonly messageIndex: number;
	readonly entryIndex: number;
	readonly origin: ReplayedImageOrigin;
	readonly entry: unknown;
	readonly decodedSha256: string | undefined;
};

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function hashImageData(data: string): string | undefined {
	if (data.length === 0 || data.length % 4 !== 0 || !BASE64.test(data)) return undefined;
	return createHash("sha256").update(Buffer.from(data, "base64")).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function originOf(
	message: Extract<Context["messages"][number], { role: "user" | "toolResult" }>,
	sdkToolName: (piToolName: string) => string,
): ReplayedImageOrigin {
	return message.role === "user"
		? { kind: "user" }
		: { kind: "tool", toolName: sdkToolName(message.toolName), toolCallId: message.toolCallId };
}

function imageBearingContent(
	history: Context["messages"],
	sdkToolName: (piToolName: string) => string,
): Map<number, { readonly origin: ReplayedImageOrigin; readonly content: readonly unknown[] }> {
	const contents = new Map<number, { readonly origin: ReplayedImageOrigin; readonly content: readonly unknown[] }>();
	history.forEach((message, messageIndex) => {
		if (message.role !== "user" && message.role !== "toolResult") return;
		if (typeof message.content === "string") return;
		contents.set(messageIndex, { origin: originOf(message, sdkToolName), content: message.content });
	});
	return contents;
}

function collectOccurrences(
	contents: ReadonlyMap<number, { readonly origin: ReplayedImageOrigin; readonly content: readonly unknown[] }>,
): ImageOccurrence[] {
	const occurrences: ImageOccurrence[] = [];
	for (const [messageIndex, { origin, content }] of contents) {
		content.forEach((entry, entryIndex) => {
			// Entries without string data or with an unsupported media type keep the
			// shared mapper's own placeholder (content-blocks.ts), as before.
			if (!isRecord(entry) || entry.type !== "image") return;
			if (typeof entry.data !== "string" || typeof entry.mimeType !== "string") return;
			if (!isSdkImageMediaType(entry.mimeType)) return;
			occurrences.push({ messageIndex, entryIndex, origin, entry, decodedSha256: hashImageData(entry.data) });
		});
	}
	return occurrences;
}

function selectUserFirstThenMostRecent(occurrences: readonly ImageOccurrence[]): ReadonlySet<string> {
	const ranked = new Map<string, { fromUser: boolean; lastSeen: number }>();
	occurrences.forEach((occurrence, order) => {
		if (occurrence.decodedSha256 === undefined) return;
		const previous = ranked.get(occurrence.decodedSha256);
		ranked.set(occurrence.decodedSha256, {
			fromUser: (previous?.fromUser ?? false) || occurrence.origin.kind === "user",
			lastSeen: order,
		});
	});
	const ordered = [...ranked.entries()].sort(
		([, a], [, b]) => Number(b.fromUser) - Number(a.fromUser) || b.lastSeen - a.lastSeen,
	);
	return new Set(ordered.slice(0, MAX_REPLAYED_HISTORY_IMAGES).map(([hash]) => hash));
}

/**
 * Rewrites the image entries of a cold-seed history (#2490): a tool-result image
 * is labeled as tool output, identical bytes are sent once and referenced in text
 * afterwards, the replay is capped, and undecodable image data is dropped with a
 * note. Returns the replacement content for each history index that holds an
 * image; every other message is replayed unchanged.
 */
export function replayHistoryImages(
	history: Context["messages"],
	sdkToolName: (piToolName: string) => string,
): ReadonlyMap<number, readonly unknown[]> {
	const contents = imageBearingContent(history, sdkToolName);
	const occurrences = collectOccurrences(contents);
	if (occurrences.length === 0) return new Map();
	const replayed = selectUserFirstThenMostRecent(occurrences);
	const firstShown = new Map<string, ReplayedImageOrigin>();
	const replacements = new Map<number, Map<number, readonly unknown[]>>();

	for (const occurrence of occurrences) {
		const { origin, entry, decodedSha256: hash } = occurrence;
		let replacement: readonly unknown[];
		if (hash === undefined) {
			replacement = [{ type: "text", text: coldSeedImageText.unreadable(origin) }];
		} else if (!replayed.has(hash)) {
			replacement = [{ type: "text", text: coldSeedImageText.capped(origin) }];
		} else {
			const first = firstShown.get(hash);
			if (first) {
				replacement = [{ type: "text", text: coldSeedImageText.duplicate(origin, first) }];
			} else {
				firstShown.set(hash, origin);
				replacement =
					origin.kind === "tool"
						? [{ type: "text", text: coldSeedImageText.toolOutput(origin.toolName) }, entry]
						: [entry];
			}
		}
		const perMessage = replacements.get(occurrence.messageIndex) ?? new Map<number, readonly unknown[]>();
		perMessage.set(occurrence.entryIndex, replacement);
		replacements.set(occurrence.messageIndex, perMessage);
	}

	const rewritten = new Map<number, readonly unknown[]>();
	for (const [messageIndex, perMessage] of replacements) {
		const content = contents.get(messageIndex)?.content ?? [];
		rewritten.set(
			messageIndex,
			content.flatMap((entry, entryIndex) => perMessage.get(entryIndex) ?? [entry]),
		);
	}
	return rewritten;
}
