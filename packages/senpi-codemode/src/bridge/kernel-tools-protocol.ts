import { type Static, Type } from "typebox";

const kernelToolErrorSchema = Type.Object({
	message: Type.String(),
	name: Type.Optional(Type.String()),
	stack: Type.Optional(Type.String()),
	code: Type.Optional(Type.String()),
});

export const kernelToolDescriptorSchema = Type.Object({
	name: Type.String({ minLength: 1 }),
	description: Type.String(),
	input_schema: Type.Unknown(),
	language: Type.Literal("js"),
	kernel_generation: Type.Integer({ minimum: 0 }),
	definition_revision: Type.Integer({ minimum: 1 }),
});

const describeResultSchema = Type.Union([
	Type.Object({
		name: Type.String({ minLength: 1 }),
		ok: Type.Literal(true),
		descriptor: kernelToolDescriptorSchema,
	}),
	Type.Object({
		name: Type.String({ minLength: 1 }),
		ok: Type.Literal(false),
		error: kernelToolErrorSchema,
	}),
]);

export const kernelToolHostToKernelSchemas = [
	Type.Object({
		type: Type.Literal("kernel-tool-describe"),
		requestId: Type.String({ minLength: 1 }),
		names: Type.Array(Type.String({ minLength: 1 })),
	}),
	Type.Object({
		type: Type.Literal("kernel-tool-invoke"),
		requestId: Type.String({ minLength: 1 }),
		name: Type.String({ minLength: 1 }),
		kernel_generation: Type.Integer({ minimum: 0 }),
		definition_revision: Type.Integer({ minimum: 1 }),
		args: Type.Unknown(),
		call_id: Type.String({ minLength: 1 }),
	}),
] as const;

export const kernelToolKernelToHostSchemas = [
	Type.Object({
		type: Type.Literal("kernel-tool-describe-reply"),
		requestId: Type.String({ minLength: 1 }),
		ok: Type.Literal(true),
		results: Type.Array(describeResultSchema),
	}),
	Type.Object({
		type: Type.Literal("kernel-tool-describe-reply"),
		requestId: Type.String({ minLength: 1 }),
		ok: Type.Literal(false),
		error: kernelToolErrorSchema,
	}),
	Type.Object({
		type: Type.Literal("kernel-tool-invoke-reply"),
		requestId: Type.String({ minLength: 1 }),
		ok: Type.Literal(true),
		value: Type.Unknown(),
	}),
	Type.Object({
		type: Type.Literal("kernel-tool-invoke-reply"),
		requestId: Type.String({ minLength: 1 }),
		ok: Type.Literal(false),
		error: kernelToolErrorSchema,
	}),
] as const;

export type KernelToolDescriptorMessage = Static<typeof kernelToolDescriptorSchema>;
