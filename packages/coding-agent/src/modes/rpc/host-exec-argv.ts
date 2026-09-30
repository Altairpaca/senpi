/**
 * Re-enter a host script with the caller's runtime options, not its entry mode.
 * Forwarding eval/print code can execute the embedding caller again and recursively
 * spawn hosts; input-type is only valid for eval/stdin, and interactive keeps a REPL alive.
 */
export function rpcHostExecArgv(execArgv: readonly string[] = process.execArgv): string[] {
	const args: string[] = [];
	for (let index = 0; index < execArgv.length; index++) {
		const arg = execArgv[index];
		if (
			arg === "-e" ||
			arg === "--eval" ||
			arg === "-pe" ||
			arg === "-ep" ||
			arg === "--input-type" ||
			arg === "--input_type"
		) {
			index++;
			continue;
		}
		if (arg === "-p" || arg === "--print") {
			// The expression is optional: `-p -e CODE` and `-p --trace-warnings` are valid.
			if (execArgv[index + 1] !== undefined && !execArgv[index + 1].startsWith("-")) index++;
			continue;
		}
		if (
			arg === "-i" ||
			arg === "--interactive" ||
			arg.startsWith("--interactive=") ||
			arg.startsWith("--eval=") ||
			arg.startsWith("--print=") ||
			arg.startsWith("--input-type=") ||
			arg.startsWith("--input_type=")
		) {
			continue;
		}
		// Do not match arbitrary -e/-p prefixes: V8 accepts -expose-gc and -predictable.
		args.push(arg);
	}
	return args;
}
