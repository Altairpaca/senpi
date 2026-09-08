import type Anthropic from "@anthropic-ai/sdk";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/compat.ts";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import { fauxAssistantMessage, fauxToolCall } from "../src/providers/faux.ts";
import type { AssistantMessage, Context, Tool, ToolResultMessage, UserMessage } from "../src/types.ts";

/**
 * Anthropic rejects a request whose message history references a tool that is
 * neither defined in `tools` nor discovered through a `tool_reference` block:
 *
 *   400 invalid_request_error: Tool reference 'mcp_computer_use_drag' not
 *   found in available tools
 *
 * Sessions outlive their tools — an MCP server can be absent after a resume,
 * an extension can stop registering a tool, or a payload hook can strip a
 * definition while history still carries the call. The provider must demote
 * those references to plain text (in lockstep with their tool_results) so the
 * turn can proceed instead of failing the whole request.
 */

interface CapturedRequest {
	params: Record<string, unknown>;
}

function createSseResponse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function finalTextResponse(): Response {
	return createSseResponse([
		{
			event: "message_start",
			data: JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_test",
					usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
				},
			}),
		},
		{
			event: "content_block_start",
			data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		},
		{
			event: "content_block_delta",
			data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
		},
		{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
		{
			event: "message_delta",
			data: JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 1 },
			}),
		},
		{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
	]);
}

function createFakeAnthropicClient(captured: CapturedRequest): Anthropic {
	return {
		beta: {
			messages: {
				create: (params: unknown) => {
					captured.params = params as Record<string, unknown>;
					return { asResponse: async () => finalTextResponse() };
				},
			},
		},
	} as Anthropic;
}

function userMessage(content: string): UserMessage {
	return { role: "user", content, timestamp: Date.now() };
}

function toolResultMessage(
	toolCallId: string,
	toolName: string,
	text: string,
	addedToolNames?: string[],
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
		...(addedToolNames ? { addedToolNames } : {}),
	};
}

function makeTool(name: string): Tool {
	return {
		name,
		description: `Test tool ${name}`,
		parameters: Type.Object({ input: Type.Optional(Type.String()) }),
	};
}

async function captureParams(
	context: Context,
	onPayload?: (payload: unknown) => unknown,
	modelId: "claude-haiku-4-5" | "claude-sonnet-4-6" = "claude-haiku-4-5",
): Promise<Record<string, unknown>> {
	const captured: CapturedRequest = { params: {} };
	const model = getModel("anthropic", modelId);
	const s = streamAnthropic(model, context, {
		apiKey: "fake-key",
		client: createFakeAnthropicClient(captured),
		...(onPayload ? { onPayload: (payload) => onPayload(payload) as never } : {}),
	});
	await s.result();
	return captured.params;
}

interface Block {
	type: string;
	id?: string;
	name?: string;
	tool_use_id?: string;
	text?: string;
	content?: unknown;
}

function messagesOf(params: Record<string, unknown>): Array<{ role: string; content: unknown }> {
	return params.messages as Array<{ role: string; content: unknown }>;
}

function blocksOf(message: { content: unknown }): Block[] {
	return Array.isArray(message.content) ? (message.content as Block[]) : [];
}

function allBlocks(params: Record<string, unknown>): Block[] {
	return messagesOf(params).flatMap((message) => blocksOf(message));
}

function toolUseBlocks(params: Record<string, unknown>): Block[] {
	return allBlocks(params).filter((block) => block.type === "tool_use");
}

function toolResultBlocks(params: Record<string, unknown>): Block[] {
	return allBlocks(params).filter((block) => block.type === "tool_result");
}

function textBlocks(params: Record<string, unknown>): Block[] {
	return allBlocks(params).filter((block) => block.type === "text");
}

function toolNamesIn(params: Record<string, unknown>): string[] {
	const tools = (params.tools ?? []) as Array<{ name: string }>;
	return tools.map((tool) => tool.name);
}

/**
 * A same-model assistant turn that ran Anthropic's native tool search. The
 * result block replays verbatim on the next request, so the names it references
 * must still resolve against that request's `tools` array.
 */
function nativeSearchTurn(referenceNames: string[], useId = "srvtoolu_search"): AssistantMessage {
	return {
		...fauxAssistantMessage("native search"),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-6",
		content: [
			{
				type: "providerNative",
				subtype: "server_tool_use",
				raw: { type: "server_tool_use", id: useId, name: "tool_search_tool_bm25", input: { query: "memory" } },
			},
			{
				type: "providerNative",
				subtype: "tool_search_tool_result",
				raw: {
					type: "tool_search_tool_result",
					tool_use_id: useId,
					content: {
						type: "tool_search_tool_search_result",
						tool_references: referenceNames.map((tool_name) => ({ type: "tool_reference", tool_name })),
					},
				},
			},
		],
	};
}

function nativeSearchResultBlocks(params: Record<string, unknown>): Array<{ tool_use_id?: string; content?: unknown }> {
	return allBlocks(params).filter((block) => block.type === "tool_search_tool_result") as Array<{
		tool_use_id?: string;
		content?: unknown;
	}>;
}

function nativeSearchReferenceNames(params: Record<string, unknown>): string[] {
	return nativeSearchResultBlocks(params).flatMap((block) => {
		const content = block.content as { tool_references?: Array<{ tool_name?: string }> } | undefined;
		return (content?.tool_references ?? []).map((reference) => reference.tool_name ?? "");
	});
}

describe("Anthropic tool-reference integrity", () => {
	it("demotes history tool calls whose tool is no longer available", async () => {
		const context: Context = {
			messages: [
				userMessage("drag the window"),
				fauxAssistantMessage(fauxToolCall("mcp_computer_use_drag", { x: 10, y: 20 }, { id: "call_gone" }), {
					stopReason: "toolUse",
				}),
				toolResultMessage("call_gone", "mcp_computer_use_drag", "dragged to 10,20"),
				userMessage("thanks"),
			],
			tools: [],
		};

		const params = await captureParams(context);

		// No tool_use or tool_result may reference the missing tool.
		expect(toolUseBlocks(params).map((block) => block.name)).not.toContain("mcp_computer_use_drag");
		expect(toolResultBlocks(params).map((block) => block.tool_use_id)).not.toContain("call_gone");

		// The history intent survives as plain text instead of failing the request.
		const texts = textBlocks(params)
			.map((block) => block.text ?? "")
			.join("\n");
		expect(texts).toContain("mcp_computer_use_drag");
		expect(texts).toContain("dragged to 10,20");

		// No empty-content messages may be left behind.
		for (const message of messagesOf(params)) {
			if (Array.isArray(message.content)) expect(message.content.length).toBeGreaterThan(0);
		}
	});

	it("demotes only the missing tool in a mixed assistant turn", async () => {
		const context: Context = {
			messages: [
				userMessage("drag then read"),
				fauxAssistantMessage(
					[
						fauxToolCall("mcp_computer_use_drag", { x: 1, y: 2 }, { id: "call_gone" }),
						fauxToolCall("read", { input: "f" }, { id: "call_kept" }),
					],
					{ stopReason: "toolUse" },
				),
				toolResultMessage("call_gone", "mcp_computer_use_drag", "dragged"),
				toolResultMessage("call_kept", "read", "file contents"),
				userMessage("go on"),
			],
			tools: [makeTool("read")],
		};

		const params = await captureParams(context);

		expect(toolUseBlocks(params).map((block) => block.name)).toEqual(["read"]);
		expect(toolResultBlocks(params).map((block) => block.tool_use_id)).toEqual(["call_kept"]);
		expect(toolNamesIn(params)).toEqual(["read"]);
	});

	it("keeps tool calls for tools that are still available", async () => {
		const context: Context = {
			messages: [
				userMessage("drag the window"),
				fauxAssistantMessage(fauxToolCall("mcp_computer_use_drag", { x: 10, y: 20 }, { id: "call_kept" }), {
					stopReason: "toolUse",
				}),
				toolResultMessage("call_kept", "mcp_computer_use_drag", "dragged"),
				userMessage("thanks"),
			],
			tools: [makeTool("mcp_computer_use_drag")],
		};

		const params = await captureParams(context);

		expect(toolUseBlocks(params).map((block) => block.name)).toContain("mcp_computer_use_drag");
		expect(toolResultBlocks(params).map((block) => block.tool_use_id)).toContain("call_kept");
	});

	it("keeps deferred tools discovered through tool_reference blocks", async () => {
		const context: Context = {
			messages: [
				userMessage("find a tool"),
				fauxAssistantMessage(fauxToolCall("tool_search", { query: "drag" }, { id: "call_search" }), {
					stopReason: "toolUse",
				}),
				toolResultMessage("call_search", "tool_search", "1 tool(s) activated", ["mcp_computer_use_drag"]),
				userMessage("done"),
			],
			tools: [makeTool("tool_search"), makeTool("mcp_computer_use_drag")],
		};

		const params = await captureParams(context, undefined, "claude-sonnet-4-6");

		// The unused activated tool ships deferred, and its tool_reference must survive.
		const tools = (params.tools ?? []) as Array<{ name: string; defer_loading?: boolean }>;
		expect(tools.some((tool) => tool.name === "mcp_computer_use_drag" && tool.defer_loading === true)).toBe(true);
		const references = toolResultBlocks(params).flatMap((block) =>
			Array.isArray(block.content) ? (block.content as Array<{ type: string; tool_name?: string }>) : [],
		);
		expect(references.some((ref) => ref.type === "tool_reference" && ref.tool_name === "mcp_computer_use_drag")).toBe(
			true,
		);
	});

	it("strips tool_reference blocks whose definition was removed by a payload hook", async () => {
		const context: Context = {
			messages: [
				userMessage("find a tool"),
				fauxAssistantMessage(fauxToolCall("tool_search", { query: "drag" }, { id: "call_search" }), {
					stopReason: "toolUse",
				}),
				toolResultMessage("call_search", "tool_search", "1 tool(s) activated", ["mcp_computer_use_drag"]),
				userMessage("done"),
			],
			tools: [makeTool("tool_search"), makeTool("mcp_computer_use_drag")],
		};

		const params = await captureParams(
			context,
			(payload) => {
				const mutable = payload as { tools?: Array<{ name: string }> };
				mutable.tools = (mutable.tools ?? []).filter((tool) => tool.name !== "mcp_computer_use_drag");
				return payload;
			},
			"claude-sonnet-4-6",
		);

		expect(toolNamesIn(params)).not.toContain("mcp_computer_use_drag");
		const references = toolResultBlocks(params).flatMap((block) =>
			Array.isArray(block.content) ? (block.content as Array<{ type: string; tool_name?: string }>) : [],
		);
		expect(references.some((ref) => ref.type === "tool_reference" && ref.tool_name === "mcp_computer_use_drag")).toBe(
			false,
		);
		// The reference-carrying tool_result must not end up with empty content.
		for (const block of toolResultBlocks(params)) {
			if (Array.isArray(block.content)) expect(block.content.length).toBeGreaterThan(0);
		}
	});
	it("normalizes gateway-namespaced native search references to the request's tool names", async () => {
		// Live 2026-09-08: the native search result replayed
		// `mcp__925c__memory` while the request defined `memory`; the namespace
		// belongs to the wire path, not to senpi, and it does not survive across
		// requests, so the next turn 400ed with "Tool reference 'mcp__925c__memory'
		// not found in available tools".
		const context: Context = {
			messages: [userMessage("find a tool"), nativeSearchTurn(["mcp__925c__memory"]), userMessage("done")],
			tools: [makeTool("tool_search"), makeTool("memory")],
		};

		const params = await captureParams(context, undefined, "claude-sonnet-4-6");

		expect(toolNamesIn(params)).toContain("memory");
		expect(nativeSearchReferenceNames(params)).toEqual(["memory"]);
		expect(allBlocks(params).some((block) => block.type === "server_tool_use")).toBe(true);
	});

	it("keeps literal native search references and drops only the ones that no longer resolve", async () => {
		const context: Context = {
			messages: [
				userMessage("find a tool"),
				nativeSearchTurn(["memory", "mcp__925c__gone", "mcp__925c__todo"]),
				userMessage("done"),
			],
			tools: [makeTool("tool_search"), makeTool("memory"), makeTool("todo")],
		};

		const params = await captureParams(context, undefined, "claude-sonnet-4-6");

		expect(nativeSearchReferenceNames(params)).toEqual(["memory", "todo"]);
	});

	it("drops a native search pair whose every reference stopped resolving", async () => {
		const context: Context = {
			messages: [userMessage("find a tool"), nativeSearchTurn(["mcp__925c__gone"]), userMessage("done")],
			tools: [makeTool("tool_search"), makeTool("memory")],
		};

		const params = await captureParams(context, undefined, "claude-sonnet-4-6");

		expect(nativeSearchResultBlocks(params)).toHaveLength(0);
		expect(allBlocks(params).some((block) => block.type === "server_tool_use")).toBe(false);
		// The assistant turn survives as text so the transcript keeps its shape.
		const assistant = messagesOf(params).filter((message) => message.role === "assistant");
		expect(assistant).toHaveLength(1);
		expect(blocksOf(assistant[0]!).every((block) => block.type === "text")).toBe(true);
		expect(JSON.stringify(params)).not.toContain('"tool_name":"mcp__925c__gone"');
	});

	it("renames a gateway-namespaced history tool call to the request's tool name", async () => {
		const context: Context = {
			messages: [
				userMessage("remember this"),
				fauxAssistantMessage(fauxToolCall("mcp__925c__memory", { input: "note" }, { id: "call_memory" }), {
					stopReason: "toolUse",
				}),
				toolResultMessage("call_memory", "mcp__925c__memory", "stored"),
				userMessage("done"),
			],
			tools: [makeTool("memory")],
		};

		const params = await captureParams(context, undefined, "claude-sonnet-4-6");

		const calls = toolUseBlocks(params);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.name).toBe("memory");
		expect(toolResultBlocks(params).map((block) => block.tool_use_id)).toEqual(["call_memory"]);
		expect(textBlocks(params).some((block) => block.text?.includes("no longer available"))).toBe(false);
	});

	it("demotes a history tool call whose only discovery was a stripped tool_reference", async () => {
		const context: Context = {
			messages: [
				userMessage("find a tool"),
				fauxAssistantMessage(fauxToolCall("tool_search", { query: "drag" }, { id: "call_search" }), {
					stopReason: "toolUse",
				}),
				toolResultMessage("call_search", "tool_search", "1 tool(s) activated", ["mcp_computer_use_drag"]),
				fauxAssistantMessage(fauxToolCall("mcp_computer_use_drag", { x: 1 }, { id: "call_drag" }), {
					stopReason: "toolUse",
				}),
				toolResultMessage("call_drag", "mcp_computer_use_drag", "dragged"),
				userMessage("done"),
			],
			tools: [makeTool("tool_search"), makeTool("mcp_computer_use_drag")],
		};

		const params = await captureParams(
			context,
			(payload) => {
				const mutable = payload as { tools?: Array<{ name: string }> };
				mutable.tools = (mutable.tools ?? []).filter((tool) => tool.name !== "mcp_computer_use_drag");
				return payload;
			},
			"claude-sonnet-4-6",
		);

		expect(toolNamesIn(params)).not.toContain("mcp_computer_use_drag");
		expect(toolUseBlocks(params).map((block) => block.name)).toEqual(["tool_search"]);
		expect(JSON.stringify(params)).not.toContain('"tool_name":"mcp_computer_use_drag"');
		expect(textBlocks(params).some((block) => block.text?.includes("mcp_computer_use_drag"))).toBe(true);
	});
});
