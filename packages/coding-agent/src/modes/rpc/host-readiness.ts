/**
 * The readiness gate of a host this process just spawned: poll `get_protocol_info` until the host
 * answers compatibly, the budget runs out, or the spawned supervisor exits.
 */
import type { HostProtocolInfo } from "./host-decision.ts";
import { probeProtocolInfo } from "./host-probe.ts";

export type ChildExit = { readonly code: number | null; readonly signal: NodeJS.Signals | null };

export type ProtocolPollResult = { readonly protocol?: HostProtocolInfo; readonly exited?: ChildExit };

const SPAWNED_HOST_PROBE_TIMEOUT_MS = 10_000;

export async function pollProtocolInfo(
	socket: string,
	timeoutMs: number,
	isCompatible: (protocol: HostProtocolInfo | undefined) => boolean,
	childExit?: Promise<ChildExit>,
): Promise<ProtocolPollResult> {
	const deadline = Date.now() + timeoutMs;
	let lastProtocol: HostProtocolInfo | undefined;
	while (Date.now() <= deadline) {
		const probe = probeProtocolInfo(
			socket,
			Math.min(SPAWNED_HOST_PROBE_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
		);
		const raced = childExit ? await Promise.race([probe, childExit]) : await probe;
		if (isChildExit(raced)) {
			// A supervisor exit can be triggered by the Windows identity watchdog
			// while a named-pipe client is still composing its protocol reply. Do
			// not terminate the host based solely on that exit until this probe has
			// had a chance to deliver an answer. A host that never answers still
			// resolves through probeProtocolInfo's bounded timeout/close handling.
			const info = await probe;
			if (info) {
				lastProtocol = info;
				if (isCompatible(info)) return { protocol: info };
			} else {
				return { protocol: lastProtocol, exited: raced };
			}
		} else if (raced) {
			lastProtocol = raced;
			if (isCompatible(raced)) return { protocol: raced };
		}
		await delay(50);
	}
	return { protocol: lastProtocol };
}

function isChildExit(value: HostProtocolInfo | ChildExit | undefined): value is ChildExit {
	return !!value && "code" in value && "signal" in value;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
