/**
 * Atomic, idempotent admission of a message another session sent this one.
 *
 * One synchronous call decides and acts: a delivery either enters the runtime (a started turn, the
 * follow-up queue or the steering queue - the same queues a user's queued input uses) exactly once,
 * or nothing happens. The ledger is the process-lifetime answer to "does this runtime hold, or has it
 * written, delivery X": a delivery is `pending` from admission until its transcript entry is
 * persisted, then `emitted`. A second admission of an id in either state is `already_admitted`.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AdmissionHoldReason,
	type AdmitExternalMessageInput,
	type AdmittedDeliveries,
	type ExternalAdmissionResult,
	type ExternalDeliverAs,
	SESSION_CONTROL_DELIVERY_TYPE,
	type SessionAdmissionGate,
	type SessionControlDeliveryDetails,
} from "./extensions/session-control-types.ts";
import type { CustomMessage } from "./messages.ts";

export type SessionControlDeliveryMessage = CustomMessage<SessionControlDeliveryDetails>;

export interface ExternalAdmissionPort {
	/** A run is active, or a prompt has claimed its start: new input queues behind it. */
	readonly isBusy: () => boolean;
	/** Synchronously enqueues into the runtime's own queue for `lane`. */
	readonly enqueue: (message: SessionControlDeliveryMessage, lane: ExternalDeliverAs) => void;
	/** Starts a turn carrying `message`; settles when that run is over, whether or not it wrote the entry. */
	readonly start: (message: SessionControlDeliveryMessage) => Promise<void>;
}

export interface EditorHoldState {
	readonly hold_reason?: AdmissionHoldReason;
	readonly revision: number;
}

type PendingLane = ExternalDeliverAs | "start";

export class ExternalAdmission {
	private turnEpochValue = 0;
	private readonly pending = new Map<string, PendingLane>();
	private readonly emitted = new Set<string>();
	private readonly emittedListeners = new Set<(deliveryId: string) => void>();
	private editorSource: (() => EditorHoldState) | undefined;
	private readonly port: ExternalAdmissionPort;

	constructor(port: ExternalAdmissionPort) {
		this.port = port;
	}

	get turnEpoch(): number {
		return this.turnEpochValue;
	}

	/** Called when an agent run begins; a steer names the epoch it was meant for. */
	beginTurn(): void {
		this.turnEpochValue += 1;
	}

	/** The composer whose draft holds admissions; `undefined` detaches it (no composer = never held). */
	setEditorSource(source: (() => EditorHoldState) | undefined): void {
		this.editorSource = source;
	}

	onEmitted(listener: (deliveryId: string) => void): () => void {
		this.emittedListeners.add(listener);
		return () => this.emittedListeners.delete(listener);
	}

	gate(): SessionAdmissionGate {
		const editor = this.editorSource?.() ?? { revision: 0 };
		const base = { editor_revision: editor.revision, turn_epoch: this.turnEpochValue };
		return editor.hold_reason === undefined
			? { can_admit: true, ...base }
			: { can_admit: false, hold_reason: editor.hold_reason, ...base };
	}

	admit(input: AdmitExternalMessageInput): ExternalAdmissionResult {
		const turn_epoch = this.turnEpochValue;
		const id = input.delivery_id;
		if (this.pending.has(id) || this.emitted.has(id)) return { kind: "already_admitted", turn_epoch };
		if (!this.gate().can_admit) return { kind: "held_draft", turn_epoch };
		if (input.expected_turn_id !== undefined && input.expected_turn_id !== turn_epoch) {
			return { kind: "turn_conflict", turn_epoch };
		}
		const message = deliveryMessage(input);
		if (!this.isBusy()) {
			this.pending.set(id, "start");
			// A start that settles without writing the entry left it queued for later (the runtime's
			// admission-retention path): from then on it is held like any queued delivery.
			void this.port.start(message).finally(() => {
				if (this.pending.get(id) === "start") this.pending.set(id, "followUp");
			});
			return { kind: "started", turn_epoch };
		}
		if (input.deliverAs === "steer") {
			if (input.expected_turn_id === undefined) return { kind: "turn_conflict", turn_epoch };
			this.pending.set(id, "steer");
			this.port.enqueue(message, "steer");
			return { kind: "steered", turn_epoch };
		}
		this.pending.set(id, "followUp");
		this.port.enqueue(message, "followUp");
		return { kind: "queued", turn_epoch };
	}

	list(): AdmittedDeliveries {
		return { pending: [...this.pending.keys()], emitted: [...this.emitted] };
	}

	/** A custom message's transcript entry was written: its delivery, if any, is now emitted. */
	observePersisted(message: AgentMessage): void {
		const id = deliveryIdOf(message);
		if (id === undefined || this.emitted.has(id)) return;
		this.pending.delete(id);
		this.emitted.add(id);
		for (const listener of this.emittedListeners) listener(id);
	}

	/** The runtime's queues were cleared: queued deliveries are no longer held. */
	dropQueued(): void {
		for (const [id, lane] of this.pending) {
			if (lane !== "start") this.pending.delete(id);
		}
	}

	private isBusy(): boolean {
		if (this.port.isBusy()) return true;
		for (const lane of this.pending.values()) if (lane === "start") return true;
		return false;
	}
}

function deliveryMessage(input: AdmitExternalMessageInput): SessionControlDeliveryMessage {
	return {
		role: "custom",
		customType: SESSION_CONTROL_DELIVERY_TYPE,
		content: input.text,
		display: true,
		details: { delivery_id: input.delivery_id, source: "session_control", deliverAs: input.deliverAs },
		timestamp: Date.now(),
	};
}

export function deliveryIdOf(message: AgentMessage): string | undefined {
	if (message.role !== "custom" || message.customType !== SESSION_CONTROL_DELIVERY_TYPE) return undefined;
	const details: unknown = message.details;
	if (typeof details !== "object" || details === null || !("delivery_id" in details)) return undefined;
	return typeof details.delivery_id === "string" ? details.delivery_id : undefined;
}
