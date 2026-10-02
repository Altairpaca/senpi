// Runtime refresh for the OpenGateway provider. The shipped catalog (generated
// from the gateway plus models.dev) stays the baseline; the gateway's public
// listing only changes availability between releases:
//
// - a servable model the shipped catalog lacks is added, built from its shipped
//   serving-tier base when there is one, priced from the gateway price table;
// - a shipped model the gateway now marks retired is removed;
// - shipped rows keep their generated metadata (input caps, thinking maps,
//   prices). Correcting those is the scheduled catalog regeneration's job.
//
// Any fetch failure keeps the last good list and surfaces as a refresh error.

import type { RefreshModelsContext } from "../models.ts";
import type { AnyModel, Model } from "../types.ts";
import { isModelType } from "../utils/model-operations.ts";
import {
	isServableChatModel,
	OPENGATEWAY_BASE_URL,
	OPENGATEWAY_MODELS_URL,
	OPENGATEWAY_PRICES_URL,
	type OpenGatewayListedModel,
	type OpenGatewayPriceTable,
	openGatewayPrice,
	parseOpenGatewayListing,
	parseOpenGatewayPriceTable,
	servingTierBase,
	withGatewayPrice,
} from "./opengateway-catalog.ts";

type OpenGatewayModel = Model<"openai-completions">;

export const OPENGATEWAY_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** Max output for an added model the gateway publishes no limit for and that has no shipped base. */
const UNPUBLISHED_MAX_OUTPUT_TOKENS = 32768;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function addedModel(
	item: OpenGatewayListedModel,
	shippedById: ReadonlyMap<string, OpenGatewayModel>,
	prices: OpenGatewayPriceTable,
): OpenGatewayModel | undefined {
	const price = openGatewayPrice(item, prices);
	// An unpriced model would bill as free in usage accounting; wait for the regeneration instead.
	if (price?.input === undefined || price.output === undefined) return undefined;
	const tier = servingTierBase(item.id);
	const base = tier ? shippedById.get(tier.baseId) : undefined;
	const contextWindow = item.contextWindow ?? base?.contextWindow;
	if (contextWindow === undefined) return undefined;
	const template: OpenGatewayModel = base
		? { ...base, name: `${base.name} ${tier?.label}` }
		: {
				id: item.id,
				name: item.id,
				api: "openai-completions",
				provider: "opengateway",
				baseUrl: OPENGATEWAY_BASE_URL,
				compat: { supportsDeveloperRole: false },
				reasoning: false,
				input: ["text"],
				cost: ZERO_COST,
				contextWindow,
				maxTokens: UNPUBLISHED_MAX_OUTPUT_TOKENS,
			};
	return {
		...template,
		id: item.id,
		input: item.inputModalities.includes("image") ? ["text", "image"] : ["text"],
		cost: withGatewayPrice(ZERO_COST, price),
		contextWindow,
		maxTokens: Math.min(item.maxOutputTokens ?? template.maxTokens, contextWindow),
	};
}

export function overlayOpenGatewayCatalog(
	shipped: readonly OpenGatewayModel[],
	listing: readonly OpenGatewayListedModel[],
	prices: OpenGatewayPriceTable,
): OpenGatewayModel[] {
	const retired = new Set(listing.filter((item) => item.status === "retired").map((item) => item.id));
	const shippedById = new Map(shipped.map((model) => [model.id, model]));
	const added = listing
		.filter((item) => isServableChatModel(item) && !shippedById.has(item.id))
		.flatMap((item) => addedModel(item, shippedById, prices) ?? []);
	return [...shipped.filter((model) => !retired.has(model.id)), ...added];
}

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
	const response = await fetch(url, { headers: { accept: "application/json" }, signal });
	if (!response.ok) throw new Error(`OpenGateway catalog request failed: ${url} returned ${response.status}`);
	return response.json();
}

function isOpenGatewayChatModel(model: AnyModel): model is OpenGatewayModel {
	return model.provider === "opengateway" && isModelType(model, "chat") && model.api === "openai-completions";
}

/**
 * Catalog state for the provider: `getModels()` is synchronous, `refresh()` restores the
 * persisted overlay and revalidates it against the gateway at most every four hours.
 * A persisted overlay older than the shipped catalog is ignored, so an upgrade never
 * resurrects metadata the new release corrected.
 */
export function createOpenGatewayCatalog(shipped: readonly OpenGatewayModel[], shippedGeneratedAt: number | undefined) {
	let current: readonly OpenGatewayModel[] = shipped;
	return {
		getModels: (): readonly OpenGatewayModel[] => current,
		refresh: async (context: RefreshModelsContext): Promise<void> => {
			const stored = context.stored;
			const storedCheckedAt = stored?.checkedAt;
			const usable =
				stored !== undefined &&
				storedCheckedAt !== undefined &&
				(shippedGeneratedAt === undefined || storedCheckedAt > shippedGeneratedAt);
			if (usable && stored) {
				const restored = stored.models.filter(isOpenGatewayChatModel);
				if (
					restored.length > 0 &&
					!(await context.publish({
						update: () => {
							current = restored;
						},
					}))
				)
					return;
			}
			if (!context.allowNetwork || context.signal.aborted) return;
			if (!context.force && usable && Date.now() - (storedCheckedAt ?? 0) < OPENGATEWAY_REFRESH_INTERVAL_MS) return;

			const [listing, prices] = await Promise.all([
				fetchJson(OPENGATEWAY_MODELS_URL, context.signal).then(parseOpenGatewayListing),
				fetchJson(OPENGATEWAY_PRICES_URL, context.signal).then(parseOpenGatewayPriceTable),
			]);
			if (context.signal.aborted) return;
			const refreshed = overlayOpenGatewayCatalog(shipped, listing, prices);
			await context.publish({
				persist: { models: refreshed, checkedAt: Date.now() },
				update: () => {
					current = refreshed;
				},
			});
		},
	};
}
