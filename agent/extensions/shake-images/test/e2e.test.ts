import assert from "node:assert/strict";
import { describe } from "node:test";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import {
	Effect,
	Encoding,
	FileSystem,
	Layer,
	Path,
	Result,
	Schedule,
} from "effect";
import {
	capture,
	e2eUnavailable,
	isDead,
	type PiSession,
	prompt,
	readStderr,
	runTask,
	sendKeys,
	setupPiSession,
	testEffect,
	waitFor,
	waitForFile,
} from "../../test/tmux.ts";

const skip = e2eUnavailable();
const { fs, path } = Effect.runSync(
	Effect.gen(function* () {
		return { fs: yield* FileSystem.FileSystem, path: yield* Path.Path };
	}).pipe(
		Effect.provide(
			Layer.mergeAll(BunFileSystem.layer, BunPath.layer, BunCrypto.layer),
		),
	),
);

const PNG_FIXTURES: ReadonlyArray<readonly [string, string]> = [
	[
		"shot-a.png",
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	],
	[
		"shot-b.png",
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC",
	],
	[
		"shot-c.png",
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC",
	],
];

const imageBlocksInTranscript = Effect.fn("imageBlocksInTranscript")(function* (
	session: PiSession,
) {
	const directory = path.join(session.cwd, "..", "sessions");
	const names = yield* fs.readDirectory(directory);
	let total = 0;
	for (const name of names.filter((entry) => entry.endsWith(".jsonl"))) {
		const content = yield* fs.readFileString(path.join(directory, name));
		total += content.match(/"type":"image"/g)?.length ?? 0;
	}
	return total;
});

describe("shake-images (real pi in tmux)", { skip }, () => {
	let session: PiSession;

	setupPiSession(
		(value) => {
			session = value;
		},
		(value) =>
			Effect.gen(function* () {
				for (const [name, base64] of PNG_FIXTURES) {
					yield* fs.writeFile(
						path.join(value.cwd, name),
						Result.getOrThrow(Encoding.decodeBase64(base64)),
					);
				}
			}),
	);

	testEffect("registers /shake-images with its description", function* () {
		assert.equal(yield* isDead(session), false);
		assert.doesNotMatch(yield* readStderr(session), /uncaughtException/);

		const banner = yield* capture(session, true);
		assert.match(
			banner,
			/\[Extensions\][\s\S]*shake-images/,
			`shake-images missing from the startup extension list:\n${banner}`,
		);

		yield* sendKeys(session, "-l", "/shake-im");
		const pane = yield* waitFor(
			session,
			/shake-images\s+.*Keep only the latest two images/,
			{ description: "/shake-images completion entry" },
		);
		assert.match(pane, /Keep only the latest two images in model context/);

		yield* sendKeys(session, "Escape");
		yield* sendKeys(session, "C-u");
		yield* waitFor(session, (text) => !text.includes("/shake-im"), {
			description: "prompt input to clear",
			timeoutMs: 15_000,
		});
	});

	testEffect("/shake-images notifies that pruning is enabled", function* () {
		yield* prompt(session, "/shake-images");
		const pane = yield* waitFor(
			session,
			/Image context pruned to the latest two images/,
			{ scrollback: true, description: "/shake-images notification" },
		);
		assert.match(pane, /Image context pruned to the latest two images/);
		assert.equal(yield* isDead(session), false);
		assert.doesNotMatch(yield* readStderr(session), /uncaughtException/);
	});

	testEffect(
		"a turn that loads three images still completes with pruning on",
		function* () {
			yield* runTask(
				session,
				"Use the read tool on shot-a.png, then shot-b.png, then shot-c.png. " +
					"After reading all three, create a file named shake-e2e.txt whose entire contents are exactly: shake-e2e-ok",
				300_000,
			);

			assert.equal(
				(yield* waitForFile(session, "shake-e2e.txt", 30_000)).trim(),
				"shake-e2e-ok",
			);

			const pane = yield* capture(session, true);
			for (const [name] of PNG_FIXTURES) {
				assert.match(
					pane,
					new RegExp(`read ${name.replace(".", "\\.")}`),
					`no read tool call for ${name}:\n${pane}`,
				);
			}

			assert.ok(
				(yield* imageBlocksInTranscript(session)) >= 3,
				"expected at least three image blocks in the session transcript; " +
					"without them the context hook never had anything to prune",
			);

			assert.equal(yield* isDead(session), false);
			assert.doesNotMatch(yield* readStderr(session), /uncaughtException/);
		},
	);

	testEffect(
		"shuts down cleanly with the session_shutdown hook registered",
		function* () {
			yield* prompt(session, "/quit");
			yield* isDead(session).pipe(
				Effect.repeat({
					schedule: Schedule.spaced(250),
					until: (dead) => dead,
				}),
				Effect.timeout(30_000),
			);
			assert.doesNotMatch(yield* readStderr(session), /uncaughtException/);
			assert.doesNotMatch(yield* readStderr(session), /ENOENT|EACCES/);
		},
	);
});
