import type { HostToKernelMessage, KernelToHostMessage } from "../../bridge/protocol.ts";
import { generateCorrelationId } from "../../bridge/protocol.ts";
import { RESERVED_AGENT_TOOL } from "../../bridge/reserved.ts";
import { kernelToolError } from "./kernel-tools-errors.ts";
import type { KernelToolsDescribeResult, KernelToolsInvokeRequest } from "./kernel-tools-types.ts";

type KernelToolReply = Extract<
	KernelToHostMessage,
	{ type: "kernel-tool-describe-reply" } | { type: "kernel-tool-invoke-reply" }
>;

type Waiter = {
	readonly resolve: (message: KernelToolReply) => void;
	readonly reject: (error: Error) => void;
};

export class KernelToolHostPump {
	readonly events = new EventTarget();
	readonly #waiters = new Map<string, Waiter>();
	readonly #post: (message: HostToKernelMessage) => void;
	readonly #isOpen: () => boolean;

	constructor(post: (message: HostToKernelMessage) => void, isOpen: () => boolean) {
		this.#post = post;
		this.#isOpen = isOpen;
	}

	consume(message: KernelToHostMessage): boolean {
		if (message.type === "tool-call" && message.toolName === RESERVED_AGENT_TOOL) {
			this.events.dispatchEvent(new Event("outerAwaitingAgent"));
		}
		if (message.type !== "kernel-tool-describe-reply" && message.type !== "kernel-tool-invoke-reply") return false;
		const waiter = this.#waiters.get(message.requestId);
		if (!waiter) return true;
		this.#waiters.delete(message.requestId);
		waiter.resolve(message);
		return true;
	}

	rejectAll(error: Error): void {
		for (const [requestId, waiter] of this.#waiters) {
			this.#waiters.delete(requestId);
			waiter.reject(error);
		}
	}

	async describe(names: readonly string[]): Promise<KernelToolsDescribeResult> {
		const reply = await this.#request({
			type: "kernel-tool-describe",
			requestId: generateCorrelationId(),
			names: [...names],
		});
		if (reply.type !== "kernel-tool-describe-reply") {
			throw kernelToolError("kernel_tool_failed", "unexpected kernel-tool describe reply");
		}
		if (!reply.ok) {
			throw kernelToolError(codeOf(reply.error.code), reply.error.message);
		}
		return { results: reply.results as KernelToolsDescribeResult["results"] };
	}

	async invoke(request: KernelToolsInvokeRequest, signal?: AbortSignal): Promise<unknown> {
		this.events.dispatchEvent(new Event("nestedInvoke"));
		const reply = await this.#request(
			{
				type: "kernel-tool-invoke",
				requestId: generateCorrelationId(),
				name: request.name,
				kernel_generation: request.kernel_generation,
				definition_revision: request.definition_revision,
				args: request.args,
				call_id: request.call_id,
			},
			signal,
		);
		if (reply.type !== "kernel-tool-invoke-reply") {
			throw kernelToolError("kernel_tool_failed", "unexpected kernel-tool invoke reply");
		}
		if (!reply.ok) throw kernelToolError(codeOf(reply.error.code), reply.error.message);
		return reply.value;
	}

	#request(
		message: Extract<HostToKernelMessage, { requestId: string }>,
		signal?: AbortSignal,
	): Promise<KernelToolReply> {
		if (!this.#isOpen()) throw kernelToolError("tools_unavailable", "JavaScript worker is not available");
		return new Promise((resolve, reject) => {
			const settle = { resolve, reject };
			this.#waiters.set(message.requestId, settle);
			const onAbort = (): void => {
				if (!this.#waiters.delete(message.requestId)) return;
				this.#post({ type: "kernel-tool-cancel", requestId: message.requestId });
				reject(kernelToolError("kernel_tool_stale", "Kernel tool call cancelled"));
			};
			if (signal?.aborted) {
				onAbort();
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			this.#post(message);
		});
	}
}

function codeOf(
	code: string | undefined,
):
	| "kernel_tool_failed"
	| "kernel_tool_stale"
	| "kernel_tool_missing"
	| "kernel_tool_recursion"
	| "tools_unavailable"
	| "invalid_tool_definition" {
	if (
		code === "kernel_tool_stale" ||
		code === "kernel_tool_missing" ||
		code === "kernel_tool_recursion" ||
		code === "tools_unavailable" ||
		code === "invalid_tool_definition"
	) {
		return code;
	}
	return "kernel_tool_failed";
}
