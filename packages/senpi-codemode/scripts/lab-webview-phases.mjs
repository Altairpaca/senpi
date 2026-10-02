// LAB INSTRUMENTATION (senpi#2353): prints each test process's chrome-backed cell phases as deltas; removed before merge.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
const ORDER = [
	"cell.start",
	"worker.port.request",
	"host.grant.start",
	"host.barrel-import.start",
	"host.barrel-import.end",
	"host.grant.connected",
	"worker.port.received",
	"worker.create.request",
	"client.create.received",
	"service.launch.start",
	"service.launch.retiring-awaited",
	"service.launch.dead-settled",
	"service.construct.start",
	"service.construct.end",
	"service.launch.adopted",
	"client.create.replied",
	"worker.create.reply",
	"worker.call.request",
	"client.call.start",
	"client.call.end",
	"worker.call.reply",
	"cell.result",
	"cell.timeout",
];

for (const iteration of readdirSync(root).sort()) {
	for (const file of readdirSync(join(root, iteration))) {
		const lines = readFileSync(join(root, iteration, file), "utf8").trim().split("\n");
		let test = "";
		let cellTest = "";
		let seen = new Map();
		let cellStart = 0;
		const flush = () => {
			if (!seen.has("service.construct.start") && !seen.has("worker.port.request")) return;
			const parts = ORDER.filter((phase) => seen.has(phase)).map((phase) => `${phase}=+${seen.get(phase) - cellStart}`);
			console.log(`${iteration} ${file} [${cellTest}] ${parts.join(" ")}`);
		};
		for (const line of lines) {
			const [stamp, , , phase, ...rest] = line.split(" ");
			const at = Date.parse(stamp);
			if (phase === "test.start") test = rest.join(" ").slice(0, 48);
			if (phase === "main-thread.lag") console.log(`${iteration} ${file} [${test}] LAG ${rest.join(" ")} at ${stamp}`);
			if (phase === "cell.start") {
				flush();
				seen = new Map();
				cellStart = at;
				cellTest = test;
			}
			if (!seen.has(phase)) seen.set(phase, at);
		}
		flush();
	}
}
