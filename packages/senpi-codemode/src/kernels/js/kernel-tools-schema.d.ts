export type KernelToolJsonSchema = {
	readonly type: "object";
	readonly properties: Readonly<Record<string, unknown>>;
	readonly required?: readonly string[];
	readonly additionalProperties?: boolean;
} & Readonly<Record<string, unknown>>;

export function defaultInputSchema(params: readonly string[]): KernelToolJsonSchema;
export function resolveToolMetadata(
	metadata: unknown,
	params: readonly string[],
): { readonly description: string; readonly input_schema: KernelToolJsonSchema };
export function validateInvokeArgs(schema: KernelToolJsonSchema, args: unknown): asserts args is Readonly<Record<string, unknown>>;
export function isPlainJsonObject(value: unknown): value is Record<string, unknown>;
export function isJsonValue(value: unknown): boolean;
export function orderedArgs(params: readonly string[], args: Readonly<Record<string, unknown>>): unknown[];
