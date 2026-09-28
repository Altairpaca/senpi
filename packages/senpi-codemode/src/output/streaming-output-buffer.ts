interface ByteSlice {
	readonly text: string;
	readonly bytes: number;
}

export function truncateHeadBytes(text: string, maxBytes: number): ByteSlice {
	if (maxBytes <= 0) return { text: "", bytes: 0 };
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= maxBytes) return { text, bytes: buffer.length };
	let end = maxBytes;
	while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
	const slice = buffer.subarray(0, end);
	return { text: slice.toString("utf8"), bytes: slice.length };
}

export function truncateTailBytes(text: string, maxBytes: number): ByteSlice {
	if (maxBytes <= 0) return { text: "", bytes: 0 };
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= maxBytes) return { text, bytes: buffer.length };
	let start = buffer.length - maxBytes;
	while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
	const slice = buffer.subarray(start);
	return { text: slice.toString("utf8"), bytes: slice.length };
}

export class TailBuffer {
	readonly #maxBytes: number;
	#text = "";
	#bytes = 0;

	constructor(maxBytes: number) {
		this.#maxBytes = Math.max(0, Math.floor(maxBytes));
	}

	append(text: string): void {
		if (text.length === 0) return;
		if (this.#maxBytes === 0) {
			this.#text = "";
			this.#bytes = 0;
			return;
		}
		const incomingBytes = Buffer.byteLength(text, "utf8");
		if (this.#bytes + incomingBytes <= this.#maxBytes) {
			// Below the budget the concatenation is already the truncated view, so the
			// encode/truncate round trip over the whole retained window can be skipped and
			// a streaming append stays proportional to the chunk (#2262).
			this.#text += text;
			this.#bytes += incomingBytes;
			return;
		}
		const next =
			incomingBytes >= this.#maxBytes
				? truncateTailBytes(text, this.#maxBytes)
				: truncateTailBytes(this.#text + text, this.#maxBytes);
		this.#text = next.text;
		this.#bytes = next.bytes;
	}

	text(): string {
		return this.#text;
	}

	bytes(): number {
		return this.#bytes;
	}
}

export interface TailLineRingOptions {
	readonly maxBytes: number;
	readonly maxLines: number;
}

/**
 * Rolling live-output window over a chunk stream: `text()` returns the last
 * `maxLines` lines of the trailing `maxBytes` byte window, byte-identical to
 * truncating the whole stream to `maxBytes` bytes and keeping its final lines,
 * while `append` costs time proportional to the chunk (#2262).
 *
 * Invariant: the retained content (compacted line groups plus recent lines,
 * joined with "\n", plus the partial current line) is a suffix of the stream
 * that either covers the whole stream or keeps the last-`maxLines`-lines window
 * reachable — older content is only dropped as whole lines when the remaining
 * lines still cover the line window, and any line trimmed from its start (only
 * for lines larger than the byte budget) is halved so repeated trims stay
 * amortized and never drop below what the byte window still needs.
 */
export class TailLineRing {
	readonly #maxBytes: number;
	readonly #maxLines: number;
	readonly #blobs: string[] = [];
	readonly #blobBytes: number[] = [];
	readonly #lines: string[] = [];
	readonly #lineBytes: number[] = [];
	#current = "";
	#currentBytes = 0;
	#bytes = 0;

	constructor(options: TailLineRingOptions) {
		this.#maxBytes = Math.max(0, Math.floor(options.maxBytes));
		this.#maxLines = Math.max(1, Math.floor(options.maxLines));
	}

	append(chunk: string): void {
		if (chunk.length === 0) return;
		let start = 0;
		for (;;) {
			const newline = chunk.indexOf("\n", start);
			const end = newline === -1 ? chunk.length : newline;
			if (end > start) {
				const piece = chunk.slice(start, end);
				const pieceBytes = Buffer.byteLength(piece, "utf8");
				this.#current += piece;
				this.#currentBytes += pieceBytes;
				this.#bytes += pieceBytes;
			}
			if (newline === -1) break;
			this.#completeLine();
			start = newline + 1;
		}
		this.#enforce();
	}

	text(): string {
		const endsWithNewline = this.#current === "" && this.#bytes > 0;
		const keptLines = endsWithNewline ? this.#maxLines : this.#maxLines - 1;
		if (this.#lines.length >= keptLines) {
			const parts = this.#lines.slice(-keptLines);
			if (!endsWithNewline) parts.push(this.#current);
			const window = `${parts.join("\n")}${endsWithNewline ? "\n" : ""}`;
			if (Buffer.byteLength(window, "utf8") <= this.#maxBytes) return window;
		}
		return this.#bytePathText(endsWithNewline);
	}

	#completeLine(): void {
		this.#lines.push(this.#current);
		this.#lineBytes.push(this.#currentBytes);
		this.#current = "";
		this.#currentBytes = 0;
		this.#bytes += 1;
		const keep = Math.max(this.#maxLines * 4, 64);
		if (this.#lines.length > keep * 2) this.#compact(keep);
	}

	/**
	 * Folds the oldest individual lines into one compacted group so a long stream of
	 * tiny lines cannot grow the line array without bound. The recent lines kept
	 * always outnumber the window, so compaction never touches rendered content.
	 */
	#compact(keep: number): void {
		const movedCount = this.#lines.length - keep;
		const moved = this.#lines.splice(0, movedCount);
		const movedBytes = this.#lineBytes.splice(0, movedCount);
		let bytes = 0;
		for (const entry of movedBytes) bytes += entry;
		this.#blobs.push(moved.join("\n"));
		this.#blobBytes.push(bytes + Math.max(0, moved.length - 1));
	}

	#enforce(): void {
		while (this.#bytes > this.#maxBytes) {
			if (this.#blobs.length > 0) {
				if (!this.#shedFront(this.#blobs, this.#blobBytes, this.#lines.length)) return;
				continue;
			}
			if (this.#lines.length > 0) {
				if (!this.#shedFront(this.#lines, this.#lineBytes, this.#lines.length - 1)) return;
				continue;
			}
			if (this.#currentBytes <= this.#maxBytes) return;
			const kept = truncateTailBytes(this.#current, Math.max(this.#maxBytes, Math.floor(this.#currentBytes / 2)));
			this.#bytes -= this.#currentBytes - kept.bytes;
			this.#current = kept.text;
			this.#currentBytes = kept.bytes;
		}
	}

	/**
	 * Drops or trims the oldest retained unit. Dropping is safe when the remaining
	 * bytes still cover the byte window or the remaining individual lines still cover
	 * the line window; otherwise the unit is trimmed from its start (halved, never
	 * below what the byte window still needs), which keeps the retained content a
	 * suffix holding at least `maxBytes` bytes. Returns false when nothing more can
	 * be shed without breaking the invariant.
	 */
	#shedFront(texts: string[], byteCosts: number[], retainedLines: number): boolean {
		const unitBytes = byteCosts[0];
		const restBytes = this.#bytes - unitBytes - 1;
		if (restBytes >= this.#maxBytes || retainedLines >= this.#maxLines) {
			texts.shift();
			byteCosts.shift();
			this.#bytes = restBytes;
			return true;
		}
		const needBytes = this.#maxBytes - restBytes;
		const keepBytes = Math.max(needBytes, unitBytes >> 1);
		if (keepBytes >= unitBytes) return false;
		const kept = truncateTailBytes(texts[0], keepBytes);
		texts[0] = kept.text;
		byteCosts[0] = kept.bytes;
		this.#bytes -= unitBytes - kept.bytes;
		return true;
	}

	#bytePathText(endsWithNewline: boolean): string {
		const units = [...this.#blobs, ...this.#lines];
		const joined = units.length === 0 ? this.#current : `${units.join("\n")}\n${this.#current}`;
		const tail = truncateTailBytes(joined, this.#maxBytes).text;
		let tailLines = tail.split("\n");
		if (endsWithNewline) tailLines = tailLines.slice(0, -1);
		return `${tailLines.slice(-this.#maxLines).join("\n")}${endsWithNewline ? "\n" : ""}`;
	}
}
