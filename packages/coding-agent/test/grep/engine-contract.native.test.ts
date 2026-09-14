import { describe } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createNativeEngine } from "../../src/core/tools/grep/native-engine.ts";
import { describeEngineContract } from "./engine-contract.ts";

const defaultPrebuildPath = join(process.cwd(), "native", "prebuilds", `${process.platform}-${process.arch}`, `senpi_grep.${process.platform}-${process.arch}.node`);

describe.skipIf(!process.env.SENPI_GREP_NATIVE_PATH && !existsSync(defaultPrebuildPath))("native", () => {
	describeEngineContract("native", () => createNativeEngine({}));
});
