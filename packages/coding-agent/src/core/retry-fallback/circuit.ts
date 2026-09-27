import { resolve } from "node:path";
import { parseRetryAfterMsMarker } from "@earendil-works/pi-ai/utils/retry-hint";
import type { FallbackLogger } from "./log.ts";

/**
 * Fallback-chain circuit breaker. An entry that fails out of a configured chain
 * opens a circuit keyed by its base selector (`provider/id`); while it is open,
 * chain resolution skips the entry instead of spending its retry budget again.
 *
 * One breaker is shared by every session in the process that uses the same agent
 * directory - the config that defines the providers and selectors - so a session
 * started by `/new`, `/resume`, or `/fork` (each gets a fresh model runtime) and
 * an in-process subagent do not re-discover a dead provider.
 * The class is clock-free: every call receives `now`, keeping sessions' injected
 * clocks authoritative and tests deterministic.
 */

export const DEFAULT_CIRCUIT_COOLDOWN_MS = 60_000;
export const DEFAULT_CIRCUIT_MAX_COOLDOWN_MS = 30 * 60_000;

export interface FallbackCircuitSettings {
	/** First cooldown after an entry fails out of a chain; doubles per consecutive open. 0 disables the breaker. */
	circuitCooldownMs?: number;
	circuitMaxCooldownMs?: number;
}

export interface ResolvedFallbackCircuitSettings {
	cooldownMs: number;
	maxCooldownMs: number;
}

export interface CircuitOpenRequest {
	now: number;
	cooldownMs: number;
	maxCooldownMs: number;
	retryAfterMs?: number;
}

export interface ProbeToken {
	readonly selector: string;
	readonly owner: string;
	readonly generation: number;
}

export type CircuitAdmission = { kind: "closed" } | { kind: "open" } | { kind: "probe"; token: ProbeToken };

interface SelectorCircuit {
	openUntil: number;
	retryFloorUntil: number;
	consecutiveOpens: number;
	cooldownMs: number;
	maxCooldownMs: number;
	generation: number;
	probe: { owner: string; generation: number } | undefined;
}

function nonNegativeMs(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function resolveFallbackCircuitSettings(
	settings: FallbackCircuitSettings | undefined,
): ResolvedFallbackCircuitSettings {
	const cooldownMs = nonNegativeMs(settings?.circuitCooldownMs, DEFAULT_CIRCUIT_COOLDOWN_MS);
	const maxCooldownMs = nonNegativeMs(settings?.circuitMaxCooldownMs, DEFAULT_CIRCUIT_MAX_COOLDOWN_MS);
	return { cooldownMs, maxCooldownMs: Math.max(cooldownMs, maxCooldownMs) };
}

export class FallbackCircuitBreaker {
	private readonly circuits = new Map<string, SelectorCircuit>();
	private generations = 0;

	get size(): number {
		return this.circuits.size;
	}

	open(selector: string, request: CircuitOpenRequest): number {
		const previous = this.circuits.get(selector);
		const consecutiveOpens = (previous?.consecutiveOpens ?? 0) + 1;
		const cooldownMs = Math.min(request.cooldownMs * 2 ** (consecutiveOpens - 1), request.maxCooldownMs);
		const retryAfterMs = request.retryAfterMs;
		const hinted =
			retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0
				? request.now + retryAfterMs
				: 0;
		const retryFloorUntil = Math.max(
			hinted,
			previous && previous.retryFloorUntil > request.now ? previous.retryFloorUntil : 0,
		);
		const openUntil = Math.max(request.now + cooldownMs, retryFloorUntil);
		this.circuits.set(selector, {
			openUntil,
			retryFloorUntil,
			consecutiveOpens,
			cooldownMs,
			maxCooldownMs: request.maxCooldownMs,
			generation: ++this.generations,
			probe: undefined,
		});
		return openUntil;
	}

	isOpen(selector: string, now: number, owner: string): boolean {
		const circuit = this.circuits.get(selector);
		if (!circuit) return false;
		if (now < circuit.openUntil) return true;
		return circuit.probe !== undefined && circuit.probe.owner !== owner;
	}

	/**
	 * Atomic admission: a closed selector passes, a cooling one or one whose probe
	 * another owner holds is refused, and a half-open one hands `owner` its single
	 * probe. The probe stays exclusive until released or settled - it never
	 * expires on a timer, so a slow probe cannot overlap a second one.
	 */
	admit(selector: string, now: number, owner: string): CircuitAdmission {
		const circuit = this.circuits.get(selector);
		if (!circuit) return { kind: "closed" };
		if (now < circuit.openUntil) return { kind: "open" };
		if (circuit.probe && circuit.probe.owner !== owner) return { kind: "open" };
		circuit.probe ??= { owner, generation: circuit.generation };
		return { kind: "probe", token: { selector, owner, generation: circuit.probe.generation } };
	}

	release(token: ProbeToken): void {
		const probe = this.circuits.get(token.selector)?.probe;
		if (probe && probe.owner === token.owner && probe.generation === token.generation) {
			const circuit = this.circuits.get(token.selector);
			if (circuit) circuit.probe = undefined;
		}
	}

	releaseOwner(owner: string): void {
		for (const circuit of this.circuits.values()) {
			if (circuit.probe?.owner === owner) circuit.probe = undefined;
		}
	}

	close(selector: string): void {
		this.circuits.delete(selector);
	}

	sweep(now: number): void {
		for (const [selector, circuit] of this.circuits) {
			if (!circuit.probe && now >= circuit.openUntil + circuit.maxCooldownMs) this.circuits.delete(selector);
		}
	}
}

export interface FallbackCircuitAccess {
	noteFailure(selector: string, failure: { retryAfterMs?: number; errorMessage?: string }): void;
	isOpen(selector: string): boolean;
	admit(selector: string): CircuitAdmission;
	release(token: ProbeToken): void;
	releaseAll(): void;
	close(selector: string): void;
}

export interface FallbackCircuitAccessDeps {
	breaker: FallbackCircuitBreaker;
	owner(): string;
	now(): number;
	settings(): ResolvedFallbackCircuitSettings;
	logger: FallbackLogger;
}

export function createFallbackCircuitAccess(deps: FallbackCircuitAccessDeps): FallbackCircuitAccess {
	const enabled = () => deps.settings().cooldownMs > 0;
	return {
		noteFailure(selector, failure) {
			if (!enabled()) return;
			const { cooldownMs, maxCooldownMs } = deps.settings();
			const now = deps.now();
			const retryAfterMs =
				failure.retryAfterMs ??
				(failure.errorMessage === undefined ? undefined : parseRetryAfterMsMarker(failure.errorMessage));
			deps.breaker.sweep(now);
			const openUntil = deps.breaker.open(selector, { now, cooldownMs, maxCooldownMs, retryAfterMs });
			deps.logger.info("circuit_opened", { selector, durationMs: openUntil - now, retryAfterMs });
		},
		isOpen: (selector) => enabled() && deps.breaker.isOpen(selector, deps.now(), deps.owner()),
		admit: (selector) => (enabled() ? deps.breaker.admit(selector, deps.now(), deps.owner()) : { kind: "closed" }),
		release: (token) => deps.breaker.release(token),
		releaseAll: () => deps.breaker.releaseOwner(deps.owner()),
		close: (selector) => deps.breaker.close(selector),
	};
}

const breakersByAgentDir = new Map<string, FallbackCircuitBreaker>();

export function fallbackCircuitsFor(agentDir: string): FallbackCircuitBreaker {
	const key = resolve(agentDir);
	let breaker = breakersByAgentDir.get(key);
	if (!breaker) {
		for (const [otherKey, other] of breakersByAgentDir) {
			if (other.size === 0) breakersByAgentDir.delete(otherKey);
		}
		breaker = new FallbackCircuitBreaker();
		breakersByAgentDir.set(key, breaker);
	}
	return breaker;
}

export function monotonicNow(): number {
	return performance.timeOrigin + performance.now();
}
