import { resolve } from "node:path";
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
	/** Provider Retry-After: authoritative, the circuit stays open until `now + retryAfterMs`. */
	retryAfterMs?: number;
}

interface SelectorCircuit {
	openUntil: number;
	consecutiveOpens: number;
	cooldownMs: number;
	probe: { owner: string; leaseUntil: number } | undefined;
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

	open(selector: string, request: CircuitOpenRequest): number {
		const consecutiveOpens = (this.circuits.get(selector)?.consecutiveOpens ?? 0) + 1;
		const cooldownMs = Math.min(request.cooldownMs * 2 ** (consecutiveOpens - 1), request.maxCooldownMs);
		const retryAfterMs = request.retryAfterMs;
		const waitMs =
			retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0
				? Math.max(retryAfterMs, cooldownMs)
				: cooldownMs;
		const openUntil = request.now + waitMs;
		this.circuits.set(selector, { openUntil, consecutiveOpens, cooldownMs, probe: undefined });
		return openUntil;
	}

	/**
	 * Whether chain resolution must skip the selector for `owner`: it is cooling
	 * down, or half-open while a different owner holds the live probe lease.
	 */
	isOpen(selector: string, now: number, owner: string): boolean {
		const circuit = this.circuits.get(selector);
		if (!circuit) return false;
		if (now < circuit.openUntil) return true;
		const probe = circuit.probe;
		return probe !== undefined && now < probe.leaseUntil && probe.owner !== owner;
	}

	/**
	 * Hands the half-open probe to `owner` for one cooldown window, so exactly one
	 * session probes a recovered entry; a crashed prober's lease simply expires.
	 */
	claimProbe(selector: string, now: number, owner: string): void {
		const circuit = this.circuits.get(selector);
		if (!circuit || this.isOpen(selector, now, owner)) return;
		circuit.probe = { owner, leaseUntil: now + Math.max(circuit.cooldownMs, 1) };
	}

	close(selector: string): void {
		this.circuits.delete(selector);
	}
}

/** One session's view of the shared breaker: its owner id, clock, and live settings are bound in. */
export interface FallbackCircuitAccess {
	noteFailure(selector: string, failure: { retryAfterMs?: number }): void;
	isOpen(selector: string): boolean;
	claimProbe(selector: string): void;
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
			const openUntil = deps.breaker.open(selector, { now, cooldownMs, maxCooldownMs, ...failure });
			deps.logger.info("circuit_opened", { selector, durationMs: openUntil - now });
		},
		isOpen: (selector) => enabled() && deps.breaker.isOpen(selector, deps.now(), deps.owner()),
		claimProbe(selector) {
			if (enabled()) deps.breaker.claimProbe(selector, deps.now(), deps.owner());
		},
		close: (selector) => deps.breaker.close(selector),
	};
}

const breakersByAgentDir = new Map<string, FallbackCircuitBreaker>();

export function fallbackCircuitsFor(agentDir: string): FallbackCircuitBreaker {
	const key = resolve(agentDir);
	let breaker = breakersByAgentDir.get(key);
	if (!breaker) {
		breaker = new FallbackCircuitBreaker();
		breakersByAgentDir.set(key, breaker);
	}
	return breaker;
}
