import { stat } from "node:fs/promises";

export class CodemodeSessionCwdUnavailableError extends Error {
	readonly name = "CodemodeSessionCwdUnavailableError";
	readonly cwd: string;

	constructor(cwd: string, reason: string) {
		super(
			`The session working directory ${cwd} is unavailable (${reason}). Eval cells run in the session's project directory; reopen the session on an existing directory.`,
		);
		this.cwd = cwd;
	}
}

export async function assertSessionCwdAvailable(cwd: string): Promise<void> {
	let isDirectory: boolean;
	try {
		isDirectory = (await stat(cwd)).isDirectory();
	} catch (error) {
		if (error instanceof Error && "code" in error && typeof error.code === "string") {
			throw new CodemodeSessionCwdUnavailableError(cwd, error.code);
		}
		throw error;
	}
	if (!isDirectory) throw new CodemodeSessionCwdUnavailableError(cwd, "not a directory");
}
