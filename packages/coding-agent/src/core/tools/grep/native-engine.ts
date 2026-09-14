import type { GrepEngine, GrepEngineRequest, GrepEngineResult } from "./engine.ts";

export function createNativeEngine(_binding: Record<string, unknown>): GrepEngine {
	return {
		name: "native",
		async search(_request: GrepEngineRequest, _signal?: AbortSignal): Promise<GrepEngineResult> {
			throw new Error("native grep engine search is implemented in the next layer");
		},
	};
}
