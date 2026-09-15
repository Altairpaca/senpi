import { describeEngineContract } from "./engine-contract.ts";
import { createRgEngine } from "../../src/core/tools/grep/rg-engine.ts";

describeEngineContract("rg", createRgEngine);
