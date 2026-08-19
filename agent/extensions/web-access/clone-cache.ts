import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { Config, Effect, FileSystem, Path } from "effect";
import { asError } from "./errors.ts";

const path = Effect.runSync(Path.Path.pipe(Effect.provide(BunPath.layer)));
const MAX_STALE_CLONE_DIRS = 1_000;

function processIsRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !(
			error instanceof Error &&
			"code" in error &&
			error.code === "ESRCH"
		);
	}
}

export const cloneCacheRoot = Effect.fn("cloneCacheRoot")(function* () {
	const tempDirectory = yield* Config.string("TMPDIR").pipe(
		Config.withDefault("/tmp"),
		Effect.mapError(asError),
	);
	return path.join(tempDirectory, "pi-web-access-repos");
});

export const clearStaleCloneCaches = Effect.fn("clearStaleCloneCaches")(
	function* () {
		const root = yield* cloneCacheRoot();
		const fs = yield* FileSystem.FileSystem;
		if (!(yield* fs.exists(root))) return 0;
		const processDirectories = (yield* fs.readDirectory(root))
			.filter((entry) => /^\d+$/.test(entry))
			.slice(0, MAX_STALE_CLONE_DIRS);
		let removed = 0;
		for (const entry of processDirectories) {
			const pid = Number(entry);
			if (pid === process.pid || processIsRunning(pid)) continue;
			yield* fs.remove(path.join(root, entry), {
				recursive: true,
				force: true,
			});
			removed++;
		}
		return removed;
	},
	Effect.provide(BunFileSystem.layer),
);
