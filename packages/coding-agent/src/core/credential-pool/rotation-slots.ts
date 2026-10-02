import type { Credential } from "@earendil-works/pi-ai";
import { listSlots as listCredentialSlots, type PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { resolveConfigValue } from "../resolve-config-value.ts";
import { discoverEnvSlots } from "./env-slots.ts";
import type { RunSlot } from "./failover.ts";
import { activeModelBlockUntil } from "./model-scope.ts";
import { acquireHalfOpenLease, type CredentialSlotRepository, type CredentialSlotState } from "./state-store.ts";

export type RotationLane = "stored" | "env";

export type RotationSlot = RunSlot & {
	lane: RotationLane;
	/** Env-lane key material for the attempt; never serialized or persisted. */
	envKey?: string;
	envVarName?: string;
	/** Stored-lane material revision binding sidecar health to the current credential; never serialized. */
	storedRevision?: string;
};

export type RotationSources = {
	providerId: string;
	credential: Credential | undefined;
	env: (name: string) => string | undefined;
	repository: CredentialSlotRepository;
	policy?: {
		affinity?: boolean;
		cooldownBaseMs?: number;
		cooldownCapMs?: number;
		slots?: Record<string, { env?: string; value?: string }>;
	};
	now?: () => number;
};

function overlayState(slot: RotationSlot, state: CredentialSlotState | undefined): RotationSlot {
	if (!state) return slot;
	return {
		...slot,
		...(state.blockedUntil === undefined ? {} : { blockedUntil: state.blockedUntil }),
		...(state.blockReason === undefined ? {} : { blockReason: state.blockReason }),
		...(state.failureCount === undefined ? {} : { failureCount: state.failureCount }),
		...(state.lease === undefined ? {} : { lease: state.lease }),
	};
}

/**
 * The slot as the requested model sees it: a live block on that model makes the
 * slot unavailable to THIS request only, until the block's own expiry (senpi#2555).
 */
function overlayModelBlock(slot: RotationSlot, until: number | undefined): RotationSlot {
	if (until === undefined || (slot.blockedUntil !== undefined && slot.blockedUntil >= until)) return slot;
	return { ...slot, blockedUntil: until, blockReason: slot.blockReason ?? "rate_limit" };
}

/**
 * Lists the provider's rotation slots with sidecar health overlaid. Stored
 * credentials own the lane when present; env slots participate only when
 * nothing is stored, preserving today's resolution precedence. An env slot's
 * persisted health applies only while its HMAC revision still matches the
 * current env value, so rotating a key in place clears its own stale block.
 */
export async function listRotationSlots(
	sources: RotationSources,
	options: { acquireLeases?: boolean; modelId?: string } = {},
): Promise<RotationSlot[]> {
	const acquireLeases = options.acquireLeases !== false;
	const modelId = options.modelId;
	const now = sources.now ?? Date.now;
	const { providerId, credential, env, repository } = sources;
	const policySlots: { name: string; envVarName: string; key: string; source: "env" }[] = [];
	for (const [name, ref] of Object.entries(sources.policy?.slots ?? {})) {
		const envVarName = ref.env ?? `models.json:${name}`;
		const key =
			ref.env !== undefined
				? env(ref.env)
				: ref.value !== undefined
					? await resolveConfigValue(ref.value, {})
					: undefined;
		if (!key) continue;
		policySlots.push({ name, envVarName, key, source: "env" });
	}
	if (credential) {
		const state = await repository.listSlots(providerId, "stored");
		const slots: RotationSlot[] = [];
		for (const slot of listCredentialSlots(credential)) {
			const persisted = state[slot.name];
			const storedRevision = await repository.storedCredentialRevision(providerId, slot.name, {
				key: slot.key,
				access: slot.access,
				refresh: slot.refresh,
			});
			// A block belongs to the material that earned it; a re-login starts clean.
			const applicable = persisted?.credentialRevision === storedRevision ? persisted : undefined;
			const modelUntil = activeModelBlockUntil(applicable?.modelBlocks, modelId, now());
			// A slot still blocked for this model never takes the half-open probe lease:
			// it cannot run, and holding the lease would starve other models' requests.
			if (
				acquireLeases &&
				modelUntil === undefined &&
				applicable?.blockedUntil !== undefined &&
				applicable.blockedUntil <= now()
			) {
				const lease = await acquireHalfOpenLease(repository, providerId, "stored", slot.name, {
					now: (sources.now ?? Date.now)(),
				});
				if (!lease) continue;
				const leased = await repository.listSlots(providerId, "stored");
				const leasedState = leased[slot.name];
				const leasedApplicable = leasedState?.credentialRevision === storedRevision ? leasedState : undefined;
				// Re-read after the awaits: a concurrent request may have blocked this model meanwhile.
				slots.push(
					overlayModelBlock(
						overlayState(
							{
								name: slot.name,
								lane: "stored",
								pinned: (credential as PooledCredential).pinned === slot.name,
								storedRevision,
							},
							leasedApplicable,
						),
						activeModelBlockUntil(leasedApplicable?.modelBlocks, modelId, now()),
					),
				);
				continue;
			}
			slots.push(
				overlayModelBlock(
					overlayState(
						{
							name: slot.name,
							lane: "stored",
							pinned: (credential as PooledCredential).pinned === slot.name,
							storedRevision,
						},
						applicable,
					),
					modelUntil,
				),
			);
		}
		if (policySlots.length === 0) return slots;
		const namedSources: RotationSources = {
			...sources,
			credential: undefined,
			policy: { ...sources.policy, slots: {} },
		};
		const namedSlots = await listEnvRotationSlots(namedSources, policySlots, acquireLeases, modelId);
		return [...slots, ...namedSlots];
	}
	const envSlots = [...discoverEnvSlots(providerId, env), ...policySlots];
	return listEnvRotationSlots(sources, envSlots, acquireLeases, modelId);
}

async function listEnvRotationSlots(
	sources: RotationSources,
	envSlots: readonly { name: string; envVarName: string; key: string }[],
	acquireLeases: boolean,
	modelId: string | undefined,
): Promise<RotationSlot[]> {
	if (envSlots.length === 0) return [];
	const { providerId, repository } = sources;
	const now = sources.now ?? Date.now;
	const state = await repository.listSlots(providerId, "env");
	const slots: RotationSlot[] = [];
	for (const slot of envSlots) {
		const persisted = state[slot.name];
		const revision = await repository.envCredentialRevision(slot.envVarName, slot.key);
		let applicable = persisted?.credentialRevision === revision ? persisted : undefined;
		let modelUntil = activeModelBlockUntil(applicable?.modelBlocks, modelId, now());
		if (
			acquireLeases &&
			modelUntil === undefined &&
			applicable?.blockedUntil !== undefined &&
			applicable.blockedUntil <= now()
		) {
			const lease = await acquireHalfOpenLease(repository, providerId, "env", slot.name, {
				now: (sources.now ?? Date.now)(),
			});
			if (!lease) continue;
			const leased = await repository.listSlots(providerId, "env");
			applicable = leased[slot.name];
			modelUntil = activeModelBlockUntil(applicable?.modelBlocks, modelId, now());
		}
		slots.push(
			overlayModelBlock(
				overlayState(
					{
						name: slot.name,
						lane: "env",
						envKey: slot.key,
						envVarName: slot.envVarName,
					},
					applicable,
				),
				modelUntil,
			),
		);
	}
	return slots;
}
