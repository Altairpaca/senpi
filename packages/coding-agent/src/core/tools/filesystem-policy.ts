import { resolve } from "node:path";
import { realpathWithoutOpen } from "../../utils/paths.ts";
import type { FilesystemPolicy, FilesystemPolicyChecker, FilesystemPolicyDecision } from "../extensions/types.ts";

const ALLOW: FilesystemPolicyDecision = { allow: true };

/**
 * Resolve a filesystem target through existing symlinks. Missing descendants
 * are appended to the nearest existing real parent so new write targets still
 * receive a stable canonical path.
 *
 * Resolution never open(2)-s a component: this runs before every read/ls/grep/find/edit/write and
 * has no deadline of its own, so a path under a wedged mount (a macOS autofs trigger whose
 * automounter never answers) would stall the tool call forever. `realpathWithoutOpen` walks
 * lstat/readlink per component, which is what realpath(3) itself relies on.
 */
export async function canonicalizeFilesystemPath(filePath: string): Promise<string> {
	return realpathWithoutOpen(resolve(filePath));
}

/** Compose extension policies in registration order. The first denial wins. */
export function composeFilesystemPolicies(policies: readonly FilesystemPolicy[]): FilesystemPolicyChecker | undefined {
	if (policies.length === 0) return undefined;

	return async (request) => {
		for (const policy of policies) {
			const decision = await policy.check(request);
			if (!decision.allow) return decision;
		}
		return ALLOW;
	};
}
