import type { GrepEngine, GrepEngineRequest, GrepEngineResult } from "./engine.ts";

const unavailable = async (_request: GrepEngineRequest, _signal?: AbortSignal): Promise<GrepEngineResult> => {
	throw new Error("rg engine search is implemented in the next layer");
};

export function createRgEngine(): GrepEngine {
	return { name: "rg", search: unavailable };
}
