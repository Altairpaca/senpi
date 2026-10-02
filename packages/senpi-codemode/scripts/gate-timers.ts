import { syncBuiltinESMExports } from "node:module";
import timers from "node:timers";
import { GateInputError } from "./gate-input-error.ts";

/**
 * Timer functions are proxied once, when this module is evaluated. The gate
 * runtime imports it first, so no module of the kernel graph can capture the
 * unobserved setTimeout/setInterval/setImmediate at its own load time.
 * Recording happens only inside an open observation window.
 */
type TimerKind = "setTimeout" | "setInterval" | "setImmediate";
type OwnedTimer = { readonly timer: object; readonly site: string };

const windows = new Set<OwnedTimer[]>();

function observeTimer<T extends (...args: never[]) => unknown>(kind: TimerKind, original: T): T {
	return new Proxy(original, {
		apply(target, receiver, args) {
			const timer: unknown = Reflect.apply(target, receiver, args);
			if (windows.size === 0) return timer;
			if (typeof timer !== "object" || timer === null || typeof Reflect.get(timer, "_destroyed") !== "boolean")
				throw new GateInputError(`${kind} observation`);
			const frames = (new Error().stack ?? "").split("\n").slice(1).map((frame) => frame.trim());
			const site = frames.find((frame) => /:\d+:\d+\)?$/.test(frame) && !frame.includes("gate-timers.ts")) ?? "unknown";
			for (const owned of windows) owned.push({ timer, site: `${kind} ${site}` });
			return timer;
		},
	});
}

const observers = {
	setTimeout: observeTimer("setTimeout", globalThis.setTimeout),
	setInterval: observeTimer("setInterval", globalThis.setInterval),
	setImmediate: observeTimer("setImmediate", globalThis.setImmediate),
};
Object.assign(globalThis, observers);
Object.assign(timers, observers);
syncBuiltinESMExports();

export function observeTimers() {
	const owned: OwnedTimer[] = [];
	windows.add(owned);
	// Timers have no close event. Bun and Node both set `_destroyed` only after
	// clear/close or a fired one-shot, so neither unref() nor refresh() hides one.
	const live = () => owned.filter((entry) => Reflect.get(entry.timer, "_destroyed") !== true);
	return {
		count: () => live().length,
		sites: () => live().map((entry) => entry.site),
		stop: () => { windows.delete(owned); },
	};
}
