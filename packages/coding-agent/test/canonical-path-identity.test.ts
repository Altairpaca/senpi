import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withFileMutationQueue } from "../src/core/tools/file-mutation-queue.ts";
import { canonicalizeFilesystemPath } from "../src/core/tools/filesystem-policy.ts";
import { realpathWithoutOpen } from "../src/utils/paths.ts";

const isWindows = process.platform === "win32";

let root = "";

afterEach(() => {
	if (root) {
		rmSync(root, { recursive: true, force: true });
		root = "";
	}
});

function createRoot(): string {
	root = mkdtempSync(join(realpathSync(tmpdir()), "canonical-identity-"));
	return root;
}

// `entry -> "jump/../secret"` with `jump -> outside/subdir`: POSIX follows jump first and lands in
// outside/secret, while collapsing `..` lexically answers allowed/secret. A containment decision fed
// the lexical answer approves one directory while the I/O reaches another, and an identity key built
// from it treats one file as two.
function createSymlinkEscapeFixture(dir: string): { readonly requested: string; readonly real: string } {
	const allowed = join(dir, "allowed");
	const outside = join(dir, "outside");
	mkdirSync(join(outside, "subdir"), { recursive: true });
	mkdirSync(join(outside, "secret"), { recursive: true });
	mkdirSync(join(allowed, "secret"), { recursive: true });
	writeFileSync(join(outside, "secret", "f.txt"), "outside");
	writeFileSync(join(allowed, "secret", "f.txt"), "allowed");
	symlinkSync(join(outside, "subdir"), join(allowed, "jump"), "dir");
	symlinkSync("jump/../secret", join(allowed, "entry"), "dir");
	return { requested: join(allowed, "entry", "f.txt"), real: join(outside, "secret", "f.txt") };
}

describe("open-free resolution agrees with realpath(3)", () => {
	it.skipIf(isWindows)("applies `..` in a symlink target after following that target's symlinks", () => {
		// given
		const dir = createRoot();
		const { requested, real } = createSymlinkEscapeFixture(dir);

		// when / then
		expect(realpathWithoutOpen(requested)).toBe(realpathSync(requested));
		expect(realpathWithoutOpen(requested)).toBe(real);
	});

	it.skipIf(isWindows)("applies `..` in the requested path after following symlinks", () => {
		// given
		const dir = createRoot();
		const real = join(dir, "real");
		mkdirSync(join(real, "inner"), { recursive: true });
		symlinkSync(join(real, "inner"), join(dir, "link"), "dir");

		// when / then
		expect(realpathWithoutOpen(join(dir, "link", "..", "target.txt"))).toBe(join(real, "target.txt"));
	});

	it("keeps a missing descendant under its resolved parent", () => {
		// given
		const dir = createRoot();

		// when / then
		expect(realpathWithoutOpen(join(dir, "missing", "leaf.txt"))).toBe(join(dir, "missing", "leaf.txt"));
	});
});

describe("canonicalizeFilesystemPath", () => {
	it.skipIf(isWindows)("fails closed on a symlink loop instead of answering with the requested path", async () => {
		// given
		const dir = createRoot();
		symlinkSync("b", join(dir, "a"), "dir");
		symlinkSync("a", join(dir, "b"), "dir");

		// when / then
		await expect(canonicalizeFilesystemPath(join(dir, "a", "file.txt"))).rejects.toThrow(/ELOOP/);
	});

	it.skipIf(isWindows)("resolves a symlink-escaping target to the file the I/O will reach", async () => {
		// given
		const dir = createRoot();
		const { requested, real } = createSymlinkEscapeFixture(dir);

		// when / then
		await expect(canonicalizeFilesystemPath(requested)).resolves.toBe(real);
	});
});

describe("file mutation queue identity", () => {
	it.skipIf(isWindows)("serializes two spellings that name one file", async () => {
		// given
		const dir = createRoot();
		const { requested, real } = createSymlinkEscapeFixture(dir);
		const started: string[] = [];
		const releaseFirst = Promise.withResolvers<void>();
		const secondStarted = Promise.withResolvers<void>();

		// when
		const first = withFileMutationQueue(requested, async () => {
			started.push("first");
			await releaseFirst.promise;
		});
		const second = withFileMutationQueue(real, async () => {
			started.push("second");
			secondStarted.resolve();
		});
		const earlySecond = await Promise.race([
			secondStarted.promise.then(() => "second-started"),
			new Promise<string>((resolveRace) => setImmediate(() => resolveRace("still-queued"))),
		]);

		// then
		expect(earlySecond).toBe("still-queued");
		expect(started).toEqual(["first"]);
		releaseFirst.resolve();
		await Promise.all([first, second]);
		expect(started).toEqual(["first", "second"]);
	}, 20_000);
});
