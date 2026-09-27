import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createFallbackCircuitAccess,
	DEFAULT_CIRCUIT_COOLDOWN_MS,
	DEFAULT_CIRCUIT_MAX_COOLDOWN_MS,
	FallbackCircuitBreaker,
	fallbackCircuitsFor,
	resolveFallbackCircuitSettings,
} from "../../src/core/retry-fallback/circuit.ts";
import type { FallbackLogger } from "../../src/core/retry-fallback/log.ts";

const head = "provider-a/model-x";
const silentLogger: FallbackLogger = { debug() {}, info() {}, warn() {} };
const window = { cooldownMs: 1_000, maxCooldownMs: 3_000 };

describe("FallbackCircuitBreaker", () => {
	it("doubles the cooldown on each consecutive open up to the ceiling", () => {
		const breaker = new FallbackCircuitBreaker();

		expect(breaker.open(head, { now: 0, ...window })).toBe(1_000);
		expect(breaker.open(head, { now: 0, ...window })).toBe(2_000);
		expect(breaker.open(head, { now: 0, ...window })).toBe(3_000);
		expect(breaker.open(head, { now: 0, ...window })).toBe(3_000);
	});

	it("resets the escalation when the circuit closes", () => {
		const breaker = new FallbackCircuitBreaker();
		breaker.open(head, { now: 0, ...window });
		breaker.open(head, { now: 0, ...window });

		breaker.close(head);

		expect(breaker.isOpen(head, 0, "a")).toBe(false);
		expect(breaker.open(head, { now: 0, ...window })).toBe(1_000);
	});

	it("keeps the circuit open until a provider Retry-After longer than the cooldown", () => {
		const breaker = new FallbackCircuitBreaker();

		expect(breaker.open(head, { now: 100, ...window, retryAfterMs: 600_000 })).toBe(600_100);
		expect(breaker.isOpen(head, 600_099, "a")).toBe(true);
		expect(breaker.isOpen(head, 600_100, "a")).toBe(false);
	});

	it("hands the half-open probe to exactly one owner until the lease expires", () => {
		const breaker = new FallbackCircuitBreaker();
		breaker.open(head, { now: 0, ...window });
		expect(breaker.isOpen(head, 999, "a")).toBe(true);

		breaker.claimProbe(head, 1_000, "a");
		breaker.claimProbe(head, 1_000, "b");

		expect(breaker.isOpen(head, 1_000, "a")).toBe(false);
		expect(breaker.isOpen(head, 1_000, "b")).toBe(true);
		expect(breaker.isOpen(head, 1_999, "b")).toBe(true);
		expect(breaker.isOpen(head, 2_000, "b")).toBe(false);
	});

	it("shares one breaker per resolved agent directory", () => {
		const agentDir = join(tmpdir(), "circuit-breaker-agent");

		expect(fallbackCircuitsFor(agentDir)).toBe(fallbackCircuitsFor(join(agentDir, "sub", "..")));
		expect(fallbackCircuitsFor(agentDir)).not.toBe(fallbackCircuitsFor(`${agentDir}-other`));
	});
});

describe("resolveFallbackCircuitSettings", () => {
	it("defaults to 60s doubling up to 30 minutes", () => {
		expect(resolveFallbackCircuitSettings(undefined)).toEqual({
			cooldownMs: DEFAULT_CIRCUIT_COOLDOWN_MS,
			maxCooldownMs: DEFAULT_CIRCUIT_MAX_COOLDOWN_MS,
		});
		expect(DEFAULT_CIRCUIT_COOLDOWN_MS).toBe(60_000);
		expect(DEFAULT_CIRCUIT_MAX_COOLDOWN_MS).toBe(1_800_000);
	});

	it("rejects malformed values and never lets the ceiling fall below the first cooldown", () => {
		expect(resolveFallbackCircuitSettings({ circuitCooldownMs: -1, circuitMaxCooldownMs: Number.NaN })).toEqual({
			cooldownMs: DEFAULT_CIRCUIT_COOLDOWN_MS,
			maxCooldownMs: DEFAULT_CIRCUIT_MAX_COOLDOWN_MS,
		});
		expect(resolveFallbackCircuitSettings({ circuitCooldownMs: 5_000, circuitMaxCooldownMs: 1_000 })).toEqual({
			cooldownMs: 5_000,
			maxCooldownMs: 5_000,
		});
	});
});

describe("createFallbackCircuitAccess", () => {
	function access(cooldownMs: number, breaker = new FallbackCircuitBreaker()) {
		return createFallbackCircuitAccess({
			breaker,
			owner: () => "session-a",
			now: () => 0,
			settings: () => ({ cooldownMs, maxCooldownMs: cooldownMs }),
			logger: silentLogger,
		});
	}

	it("opens circuits with the session's clock and settings", () => {
		const circuits = access(1_000);

		circuits.noteFailure(head, {});

		expect(circuits.isOpen(head)).toBe(true);
	});

	it("neither opens nor honours circuits when circuitCooldownMs is 0", () => {
		const breaker = new FallbackCircuitBreaker();
		breaker.open(head, { now: 0, ...window });
		const circuits = access(0, breaker);

		circuits.noteFailure("provider-b/model-y", {});

		expect(circuits.isOpen(head)).toBe(false);
		expect(breaker.isOpen("provider-b/model-y", 0, "session-a")).toBe(false);
	});
});
