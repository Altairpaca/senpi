import type { Api, Model, ProviderId } from "./types.ts";

export type ModelGroups = Record<string, Record<string, object>>;

const MAX_EFFORT_MODEL_IDS = new Set<string>();

/** Exact-id lookup, matching getBuiltinModel(): provider namespaces remain part of the model id. */
export function builtinCatalogAdvertisesMax(modelId: string): boolean {
	return MAX_EFFORT_MODEL_IDS.has(modelId);
}

type ModelId<TGroups extends ModelGroups> = {
	[TApi in keyof TGroups]: keyof TGroups[TApi];
}[keyof TGroups] &
	string;

type ModelApi<TGroups extends ModelGroups, TModelId extends ModelId<TGroups>> = {
	[TApi in keyof TGroups]: TModelId extends keyof TGroups[TApi] ? TApi : never;
}[keyof TGroups] &
	Api;

export type ModelCatalog<TGroups extends ModelGroups, TProvider extends ProviderId> = {
	[TModelId in ModelId<TGroups>]: Model<ModelApi<TGroups, TModelId>> & {
		id: TModelId;
		provider: TProvider;
	};
};

export function flattenModelCatalog<const TProvider extends ProviderId, const TGroups extends ModelGroups>(
	_provider: TProvider,
	groups: TGroups,
): ModelCatalog<TGroups, TProvider> {
	const catalog = Object.assign({}, ...Object.values(groups)) as ModelCatalog<TGroups, TProvider>;
	for (const model of Object.values(catalog) as Model<Api>[]) {
		if (typeof model.thinkingLevelMap?.max === "string") MAX_EFFORT_MODEL_IDS.add(model.id);
	}
	return catalog;
}
