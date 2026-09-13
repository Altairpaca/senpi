import type { EvalLanguage } from "../../src/tool/types.ts";
import { agentSpec, items, poolId } from "./fixture.ts";

const data = JSON.stringify({ agent: agentSpec, items, pool_id: poolId });
export const setup: Readonly<Record<EvalLanguage, string>> = {
	js: `const wpData = ${data};`,
	py: `import json\nwpData = json.loads(${JSON.stringify(data)})`,
	rb: `wpData = JSON.parse(${JSON.stringify(data)})`,
	jl: `wpData = senpi_json_parse(${JSON.stringify(data)})`,
};
export const create: Readonly<Record<EvalLanguage, string>> = {
	js: "const pool = await workpool(wpData.agent, 'batch', { mode: 'fresh' });",
	py: "pool = workpool(wpData['agent'], 'batch', mode='fresh')",
	rb: "pool = workpool(wpData['agent'], 'batch', mode: 'fresh')",
	jl: 'pool = workpool(wpData["agent"], "batch", mode="fresh")',
};
export const operations: Readonly<Record<EvalLanguage, string>> = {
	js: "display({ pool_id: pool.pool_id, push: await pool.push(wpData.items), inspect: await pool.inspect(), close: await pool.close(), cancel: await pool.cancel() });",
	py: "display({'pool_id': pool.pool_id, 'push': pool.push(wpData['items']), 'inspect': pool.inspect(), 'close': pool.close(), 'cancel': pool.cancel()})",
	rb: "display({pool_id: pool.pool_id, push: pool.push(wpData['items']), inspect: pool.inspect(), close: pool.close(), cancel: pool.cancel()})",
	jl: 'display(Dict("pool_id" => pool.pool_id, "push" => pool.push(wpData["items"]), "inspect" => pool.inspect(), "close" => pool.close(), "cancel" => pool.cancel()))',
};
export const omittedMode: Readonly<Record<EvalLanguage, string>> = {
	js: "await workpool(wpData.agent, 'default');",
	py: "workpool(wpData['agent'], 'default')",
	rb: "workpool(wpData['agent'], 'default')",
	jl: 'workpool(wpData["agent"], "default")',
};
export const inspectById: Readonly<Record<EvalLanguage, string>> = {
	js: `display({inspection: await tool.workpool({ op: 'inspect', pool_id: '${poolId}' })});`,
	py: `display({'inspection': tool.workpool(op='inspect', pool_id='${poolId}')})`,
	rb: `display({inspection: tool.workpool(op: 'inspect', pool_id: '${poolId}')})`,
	jl: `display(Dict("inspection" => tool.workpool(op="inspect", pool_id="${poolId}")))`,
};
export function catchCode(language: EvalLanguage, code: string): string {
	switch (language) {
		case "js":
			return `try { ${code} } catch (error) { display({ code: error.code }); }`;
		case "py":
			return `try:\n${code
				.split("\n")
				.map((line) => `    ${line}`)
				.join("\n")}\nexcept Exception as error:\n    display({'code': error.code})`;
		case "rb":
			return `begin\n${code}\nrescue => error\n display({code: error.code})\nend`;
		case "jl":
			return `try\n${code}\ncatch error\n display(Dict("code" => error.code))\nend`;
	}
}
export const handle: Readonly<Record<EvalLanguage, string>> = {
	js: "display(await agent('fixture', { handle: true }));",
	py: "display(agent('fixture', handle=True))",
	rb: "display(agent('fixture', handle: true))",
	jl: 'display(agent("fixture", handle=true))',
};
