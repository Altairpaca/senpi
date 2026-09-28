import type { EvalDetachedCellSnapshot } from "./detached-cell-contract.ts";
import type { EvalLanguage } from "./types.ts";

export const TERMINAL_SNAPSHOT_CAP = 32;

export interface TerminalSnapshotStoreOptions {
	readonly cap?: number;
	/** Upper bound on the estimated bytes of all retained snapshots; 0 keeps only the count cap. */
	readonly byteBudget?: number;
}

/**
 * Bounded LRU of settled-cell snapshots; without it every settled cell pins its result and closures for
 * the session lifetime (#1695). Bounded by count and by estimated bytes so image-heavy results cannot
 * pin hundreds of megabytes (#2259); the newest snapshot is always kept so a just-settled cell stays peekable.
 */
export class TerminalSnapshotStore {
	readonly #snapshots = new Map<string, { readonly snapshot: EvalDetachedCellSnapshot; readonly bytes: number }>();
	readonly #cap: number;
	readonly #byteBudget: number;
	#bytes = 0;

	constructor(options: TerminalSnapshotStoreOptions = {}) {
		this.#cap = options.cap ?? TERMINAL_SNAPSHOT_CAP;
		this.#byteBudget = options.byteBudget ?? 0;
	}

	get bytes(): number {
		return this.#bytes;
	}

	remember(snapshot: EvalDetachedCellSnapshot): void {
		this.delete(snapshot.cellId);
		const bytes = estimateSnapshotBytes(snapshot);
		this.#snapshots.set(snapshot.cellId, { snapshot, bytes });
		this.#bytes += bytes;
		while (this.#snapshots.size > 1 && (this.#snapshots.size > this.#cap || this.#overBudget())) {
			const oldest = this.#snapshots.keys().next();
			if (oldest.done === true) break;
			this.delete(oldest.value);
		}
	}

	get(cellId: string): EvalDetachedCellSnapshot | undefined {
		return this.#snapshots.get(cellId)?.snapshot;
	}

	delete(cellId: string): void {
		const entry = this.#snapshots.get(cellId);
		if (entry === undefined) return;
		this.#snapshots.delete(cellId);
		this.#bytes -= entry.bytes;
	}

	forgetLanguage(language: EvalLanguage): void {
		for (const [cellId, entry] of this.#snapshots) {
			if (entry.snapshot.language === language) this.delete(cellId);
		}
	}

	list(): readonly EvalDetachedCellSnapshot[] {
		return [...this.#snapshots.values()].map((entry) => entry.snapshot);
	}

	clear(): void {
		this.#snapshots.clear();
		this.#bytes = 0;
	}

	#overBudget(): boolean {
		return this.#byteBudget > 0 && this.#bytes > this.#byteBudget;
	}
}

export function estimateSnapshotBytes(snapshot: EvalDetachedCellSnapshot): number {
	let bytes = snapshot.outputTail.length * 2;
	for (const part of snapshot.result.content) {
		bytes += part.type === "text" ? part.text.length * 2 : part.data.length;
	}
	for (const cell of snapshot.result.details.cells ?? []) {
		bytes += (cell.output.length + cell.code.length) * 2;
	}
	const jsonOutputs = snapshot.result.details.jsonOutputs;
	if (jsonOutputs !== undefined && jsonOutputs.length > 0) bytes += JSON.stringify(jsonOutputs).length;
	return bytes;
}
