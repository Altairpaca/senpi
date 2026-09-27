import type { ModelThinkingLevel, ThinkingLevelMap } from "./types.ts";

/**
 * Reasoning levels an OpenAI-compatible endpoint advertises for one model through the
 * `reasoning_efforts` field of its `/models` listing (senpi#2196).
 */
export interface EndpointReasoningEfforts {
	/**
	 * senpi level -> the endpoint's own spelling, sent on the wire as-is. Every level the endpoint
	 * did not advertise is `null`, so the map is authoritative and no level is inferred from the id.
	 * Absent when no advertised value names a senpi level.
	 */
	thinkingLevelMap?: ThinkingLevelMap;
	/** Level of the entry the endpoint marks `default: true`, when that entry maps. */
	defaultThinkingLevel?: ModelThinkingLevel;
	/** Advertised values that name no senpi level; reported, never sent. */
	unmapped: string[];
}

const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const LEVEL_BY_NAME: Readonly<Record<string, ModelThinkingLevel>> = {
	none: "off",
	off: "off",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

function readEntry(entry: unknown): { value: string; isDefault: boolean } | undefined {
	if (typeof entry === "string") return entry.trim() ? { value: entry, isDefault: false } : undefined;
	if (typeof entry !== "object" || entry === null) return undefined;
	const { value, default: isDefault } = entry as { value?: unknown; default?: unknown };
	return typeof value === "string" && value.trim() ? { value, isDefault: isDefault === true } : undefined;
}

/**
 * Map a `reasoning_efforts` listing (`[{ "value": "low" }, { "value": "high", "default": true }]`,
 * or plain strings) onto senpi's levels. Matching is case-insensitive; the first spelling of a
 * level wins. Returns undefined when the listing holds no usable entry.
 */
export function parseEndpointReasoningEfforts(value: unknown): EndpointReasoningEfforts | undefined {
	if (!Array.isArray(value)) return undefined;
	const advertised = new Map<ModelThinkingLevel, string>();
	const unmapped: string[] = [];
	let defaultThinkingLevel: ModelThinkingLevel | undefined;
	let sawEntry = false;
	for (const raw of value) {
		const entry = readEntry(raw);
		if (!entry) continue;
		sawEntry = true;
		const level = LEVEL_BY_NAME[entry.value.trim().toLowerCase()];
		if (!level) {
			if (!unmapped.includes(entry.value)) unmapped.push(entry.value);
			continue;
		}
		if (!advertised.has(level)) advertised.set(level, entry.value);
		if (entry.isDefault && defaultThinkingLevel === undefined) defaultThinkingLevel = level;
	}
	if (!sawEntry) return undefined;
	if (advertised.size === 0) return { unmapped };
	const thinkingLevelMap: ThinkingLevelMap = {};
	for (const level of THINKING_LEVELS) thinkingLevelMap[level] = advertised.get(level) ?? null;
	return defaultThinkingLevel === undefined
		? { thinkingLevelMap, unmapped }
		: { thinkingLevelMap, defaultThinkingLevel, unmapped };
}
