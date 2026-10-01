import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const driver = fileURLToPath(new URL("../scripts/qa-shell-stop.ts", import.meta.url));

async function runDriver(mode: string): Promise<{ readonly report: unknown; readonly stdout: string }> {
	const child = spawn("bun", [driver, mode], { stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	const exited = new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	try {
		expect(await exited, stderr).toBe(0);
		const report: unknown = JSON.parse(stdout.split("\n")[0] ?? "");
		return { report, stdout };
	} finally {
		child.kill();
	}
}

describe("Bun shell Stop", () => {
	it.each(["shell", "text", "lines"])(
		"reports state loss when Stop interrupts a native %s wait",
		async (mode) => {
			// Given a real kernel and a command that announces readiness through a socket.
			// When the driver stops the command after its readiness event.
			const { report, stdout } = await runDriver(mode);
			// Then the command has exited, globals are cleared, and the result names the restart class.
			expect(report).toMatchObject({
				retained: false,
				result: { ok: false, error: { code: "js_shell_interrupt_restart" } },
				note: expect.any(String),
				next: { ok: true },
			});
			expect(report).not.toHaveProperty("next.valueRepr");
			expect(stdout).toContain("COMMAND_EXITED");
		},
		90_000,
	);

	it("keeps globals without a shell restart notice when Stop interrupts a normal await", async () => {
		// Given a completed native shell followed by a host-tool wait.
		// When Stop interrupts that wait after its tool-call event.
		const { report } = await runDriver("normal");
		// Then globals survive and the former shell cannot contaminate the outcome.
		expect(report).toMatchObject({ retained: true, result: { ok: false }, next: { ok: true, valueRepr: "41" } });
		expect(report).not.toHaveProperty("note");
		expect(report).not.toHaveProperty("result.error.code");
	}, 90_000);

	it("keeps normal shell output and globals when the cell finishes", async () => {
		// Given a native shell that prints one line.
		// When it completes without interruption.
		const { report } = await runDriver("finished");
		// Then its output and persistent variables are unchanged.
		expect(report).toMatchObject({
			completed: { ok: true, valueRepr: '"normal\\n"' },
			next: { ok: true, valueRepr: "41" },
		});
	}, 90_000);
});
