import { afterEach, describe, expect, it } from "vitest";
import { complete, fauxAssistantMessage, registerFauxProvider, resetApiProviders } from "../src/compat.ts";
import type { Context } from "../src/types.ts";

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };
const registrations: Array<{ unregister: () => void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) registration.unregister();
});

// senpi#2542: a session reload resets the API-provider registry; the caller's faux provider must outlive it.
describe("faux provider across an API registry reset", () => {
	it("keeps answering after resetApiProviders", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([fauxAssistantMessage("still here")]);

		resetApiProviders();
		const response = await complete(registration.getModel(), context);

		expect(response.content).toEqual([{ type: "text", text: "still here" }]);
		expect(registration.state.callCount).toBe(1);
	});

	it("keeps a second registration's queued replies separate after the reset", async () => {
		const first = registerFauxProvider();
		const second = registerFauxProvider();
		registrations.push(first, second);
		first.setResponses([fauxAssistantMessage("from first")]);
		second.setResponses([fauxAssistantMessage("from second")]);

		resetApiProviders();

		expect((await complete(second.getModel(), context)).content).toEqual([{ type: "text", text: "from second" }]);
		expect((await complete(first.getModel(), context)).content).toEqual([{ type: "text", text: "from first" }]);
	});

	it("stops answering once unregistered, even if a reset happened in between", async () => {
		const registration = registerFauxProvider();
		registration.setResponses([fauxAssistantMessage("should not be sent")]);

		resetApiProviders();
		registration.unregister();

		await expect(complete(registration.getModel(), context)).rejects.toThrow(
			`No API provider registered for api: ${registration.api}`,
		);
		expect(registration.state.callCount).toBe(0);
	});
});
