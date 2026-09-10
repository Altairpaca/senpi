import type { Credential } from "../types.ts";

export type { Credential };

export const DEFAULT_SLOT_NAME = "default";

export type CredentialSlotSource = "login" | "import" | "env";

export type CredentialSlot = {
	name: string;
	source?: CredentialSlotSource;
	key?: string;
	access?: string;
	refresh?: string;
	expires?: number;
};

export type PooledCredential = Credential & {
	accounts?: CredentialSlot[];
	pinned?: string;
};

const SLOT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function assertValidSlotName(name: string): void {
	if (!SLOT_NAME_PATTERN.test(name)) {
		throw new Error(
			`Invalid account name '${name}': use letters, digits, '-' or '_', starting with a letter or digit`,
		);
	}
}

function storedSlots(credential: PooledCredential): CredentialSlot[] {
	return Array.isArray(credential.accounts) ? credential.accounts : [];
}

function slotFromFlatCredential(credential: PooledCredential): CredentialSlot {
	if (credential.type === "oauth") {
		return {
			name: DEFAULT_SLOT_NAME,
			source: "login",
			access: credential.access,
			refresh: credential.refresh,
			expires: credential.expires,
		};
	}
	return { name: DEFAULT_SLOT_NAME, source: "login", key: credential.key };
}

/**
 * A flat credential written by a build predating pools is read as a one-slot pool
 * without writing anything back; the caller decides whether a write ever happens.
 */
export function listSlots(credential: PooledCredential | undefined): CredentialSlot[] {
	if (!credential) return [];
	const slots = storedSlots(credential);
	return slots.length > 0 ? [...slots] : [slotFromFlatCredential(credential)];
}

export function findSlot(credential: PooledCredential | undefined, name: string): CredentialSlot | undefined {
	return listSlots(credential).find((slot) => slot.name === name);
}

/**
 * Replaces or appends one slot while every sibling, the pin, and the flat
 * top-level credential survive untouched. The flat fields stay as written so a
 * build that ignores `accounts` still authenticates from them.
 */
export function upsertSlot(credential: PooledCredential | undefined, slot: CredentialSlot): PooledCredential {
	assertValidSlotName(slot.name);
	const base: PooledCredential =
		credential ??
		(slot.access !== undefined || slot.refresh !== undefined
			? { type: "oauth", access: slot.access ?? "", refresh: slot.refresh ?? "", expires: slot.expires ?? 0 }
			: { type: "api_key", key: slot.key });
	const existing = listSlots(base);
	const index = existing.findIndex((candidate) => candidate.name === slot.name);
	const accounts =
		index >= 0
			? existing.map((candidate) => (candidate.name === slot.name ? { ...candidate, ...slot } : candidate))
			: [...existing, slot];
	return { ...base, accounts };
}

/** Whether the flat top-level fields are this slot's material rather than a sibling's. */
function slotMirrorsFlat(credential: PooledCredential, slot: CredentialSlot): boolean {
	if (credential.type === "oauth") return slot.access === credential.access || slot.refresh === credential.refresh;
	return slot.key === credential.key;
}

/** Rewrites the flat top-level projection to carry the given slot's material. */
function projectFlatFields(credential: PooledCredential, slot: CredentialSlot): PooledCredential {
	if (credential.type === "oauth") {
		if (slot.access === undefined || slot.refresh === undefined || slot.expires === undefined) return credential;
		return { ...credential, access: slot.access, refresh: slot.refresh, expires: slot.expires };
	}
	return { ...credential, key: slot.key };
}

/**
 * Removes one slot. The credential is dropped entirely once its last slot is gone,
 * and a pin naming the removed slot is cleared so selection never points at a slot
 * that no longer exists.
 *
 * When the removed slot was the one the flat top-level fields projected, those
 * fields are re-projected from the first survivor. Without that the pool keeps
 * authenticating with the deleted account's material: a credential with a single
 * remaining slot does not enter the rotation path, so ordinary requests resolve
 * the flat projection and would keep using exactly the account the user removed.
 * `accounts` is preserved either way, so the entry stays a pool.
 */
export function removeSlot(credential: PooledCredential | undefined, name: string): PooledCredential | undefined {
	if (!credential) return undefined;
	const existing = listSlots(credential);
	const removed = existing.find((slot) => slot.name === name);
	const accounts = existing.filter((slot) => slot.name !== name);
	if (accounts.length === 0) return undefined;
	const reprojected =
		removed && slotMirrorsFlat(credential, removed) ? projectFlatFields(credential, accounts[0]) : credential;
	const next: PooledCredential = { ...reprojected, accounts };
	if (next.pinned === name) delete next.pinned;
	return next;
}

export function pinSlot(credential: PooledCredential, name: string): PooledCredential {
	assertValidSlotName(name);
	return { ...credential, pinned: name };
}

/**
 * Projects one named slot onto the flat credential shape for request-scoped
 * resolution; pool bookkeeping fields are stripped so provider handlers see a
 * plain credential and never write pool state back through the projection.
 */
export function projectSlot(credential: PooledCredential | undefined, name: string): Credential | undefined {
	if (!credential) return undefined;
	const slot = findSlot(credential, name);
	if (!slot) return undefined;
	const { accounts: _accounts, pinned: _pinned, ...flat } = credential;
	if (flat.type === "oauth") {
		if (slot.access === undefined || slot.refresh === undefined || slot.expires === undefined) return undefined;
		return { ...flat, access: slot.access, refresh: slot.refresh, expires: slot.expires };
	}
	return { ...flat, key: slot.key };
}

function slotFromFlatCredentialNamed(credential: Credential, name: string): CredentialSlot {
	if (credential.type === "oauth") {
		return {
			name,
			source: "login",
			access: credential.access,
			refresh: credential.refresh,
			expires: credential.expires,
		};
	}
	return { name, source: "login", key: credential.key };
}

function nextLoginSlotName(credential: PooledCredential): string {
	const taken = new Set(listSlots(credential).map((slot) => slot.name));
	for (let index = 2; index < 1000; index++) {
		const candidate = `login-${index}`;
		if (!taken.has(candidate)) return candidate;
	}
	throw new Error("Credential pool is full");
}

function providedSlots(credential: Credential): CredentialSlot[] | undefined {
	const accounts = (credential as PooledCredential).accounts;
	return Array.isArray(accounts) && accounts.length > 0 ? accounts : undefined;
}

/**
 * Unions a provider-owned pool onto the value read under the credential lock.
 * `current` wins for every name it already holds: the provider built its
 * object from a snapshot taken BEFORE the interactive browser round trip, so a
 * sibling account that rotated its refresh token or earned a rate-limit block
 * during that window must not be rewound to the snapshot. Only names that do
 * not exist yet are appended.
 */
function mergeProvidedPool(
	current: PooledCredential,
	existing: readonly CredentialSlot[],
	provided: readonly CredentialSlot[],
): PooledCredential {
	const known = new Set(existing.map((slot) => slot.name));
	const added = provided.filter((slot) => !known.has(slot.name));
	return added.length === 0 ? current : { ...current, accounts: [...existing, ...added] };
}

/**
 * Appends an unnamed flat credential to a pool as a generated `login-N` slot.
 * An absent current entry keeps today's whole-write shape; a flat current entry
 * is promoted to a pool so the legacy credential stays reachable as `default`
 * instead of being overwritten by the second login.
 *
 * A login result that already carries its own populated `accounts` array is a
 * provider-owned pool, and a provider that already holds a POOL names the
 * account this login created itself. That pool is MERGED onto `current` rather
 * than written through: a pre-browser-flow snapshot must never overwrite what
 * concurrent writers stored meanwhile. A flat `current` keeps the whole-write
 * shape - the provider echoes the flat fields it read, so there is nothing to
 * preserve and the login must not be dropped on a name collision.
 */
export function appendLoginSlot(current: PooledCredential | undefined, flat: Credential): Credential {
	if (!current) {
		return flat;
	}
	const storedAccounts = Array.isArray(current.accounts) ? current.accounts : undefined;
	const provided = providedSlots(flat);
	if (provided) {
		// A pool merges onto the stored pool; a flat current keeps the whole-write
		// shape because the provider's accounts already carry this login.
		return storedAccounts ? mergeProvidedPool(current, storedAccounts, provided) : flat;
	}
	return upsertSlot(current, slotFromFlatCredentialNamed(flat, nextLoginSlotName(current)));
}

/**
 * Material a provider writes into the flat credential when the real token lives
 * outside auth.json (an SDK subprocess or a vendor CLI owns it): the literal
 * `<providerId>-managed` in both OAuth fields. It is a marker, never a token.
 */
export function managedSentinelMaterial(providerId: string): string {
	return `${providerId}-managed`;
}

/**
 * A POOL SLOT carrying that marker can never authenticate: `projectSlot` hands
 * it to the provider's `check`, which rejects it, and the request dies with
 * "Provider is not configured". Slots like that exist only because a shipped
 * build appended a provider-owned pool's flat sentinel as a generated `login-N`
 * slot.
 */
export function isManagedSentinelSlot(providerId: string, slot: CredentialSlot): boolean {
	const sentinel = managedSentinelMaterial(providerId);
	return slot.access === sentinel && slot.refresh === sentinel;
}

/**
 * Drops those poisoned slots from a stored credential, clearing a pin that
 * named one. Returns `undefined` when the credential holds none, so a caller
 * can tell a repair from a no-op and only rewrite storage when the bytes
 * actually change.
 */
export function repairManagedSentinelSlots(providerId: string, credential: Credential): PooledCredential | undefined {
	const pooled = credential as PooledCredential;
	if (!Array.isArray(pooled.accounts)) return undefined;
	const kept = pooled.accounts.filter((slot) => !isManagedSentinelSlot(providerId, slot));
	if (kept.length === pooled.accounts.length) return undefined;
	const repaired: PooledCredential = { ...pooled, accounts: kept };
	if (repaired.pinned !== undefined && !kept.some((slot) => slot.name === repaired.pinned)) delete repaired.pinned;
	return repaired;
}

/**
 * Merges a rotated OAuth credential back into the pool: the slot whose material
 * matches the pre-refresh flat fields is updated in place together with those
 * flat fields, while every sibling and the pin survive byte-identical. A flat
 * current entry keeps today's whole-write shape.
 */
/**
 * Merges a rotated OAuth credential into the NAMED slot. The flat top-level
 * projection rotates only when it mirrored that slot's previous material, so
 * refreshing a secondary slot never disturbs what an older binary reads.
 */
export function mergeRefreshedSlot(current: PooledCredential, name: string, refreshed: Credential): Credential {
	if (refreshed.type !== "oauth" || current.type !== "oauth") return current;
	if (!Array.isArray(current.accounts) || current.accounts.length === 0) return mergeRefreshed(current, refreshed);
	const target = current.accounts.find((slot) => slot.name === name);
	if (!target) return current;
	const rotated = { access: refreshed.access, refresh: refreshed.refresh, expires: refreshed.expires };
	const accounts = current.accounts.map((slot) => (slot === target ? { ...slot, ...rotated } : slot));
	const mirrorsFlat = target.access === current.access || target.refresh === current.refresh;
	return mirrorsFlat ? { ...current, ...rotated, accounts } : { ...current, accounts };
}

export function mergeRefreshed(current: PooledCredential, refreshed: Credential): Credential {
	if (!Array.isArray(current.accounts) || current.accounts.length === 0) {
		return refreshed;
	}
	if (refreshed.type !== "oauth" || current.type !== "oauth") return refreshed;
	const target = current.accounts.find((slot) => slot.access === current.access || slot.refresh === current.refresh);
	const rotated = {
		access: refreshed.access,
		refresh: refreshed.refresh,
		expires: refreshed.expires,
	};
	const accounts = target
		? current.accounts.map((slot) => (slot === target ? { ...slot, ...rotated } : slot))
		: current.accounts;
	return { ...current, ...rotated, accounts };
}
