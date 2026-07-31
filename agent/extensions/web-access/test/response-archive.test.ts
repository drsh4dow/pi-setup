import assert from "node:assert/strict";
import { test } from "node:test";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, FileSystem } from "effect";
import { openSessionResponseArchive } from "../response-archive.ts";

const fs = Effect.runSync(
	FileSystem.FileSystem.pipe(Effect.provide(BunFileSystem.layer)),
);

const withRoot = <A, E>(
	use: (root: string, fs: FileSystem.FileSystem) => Effect.Effect<A, E>,
): Promise<A> =>
	Effect.runPromise(
		Effect.acquireUseRelease(
			fs.makeTempDirectory({ prefix: "pi-web-access-archive-test-" }),
			(root) => use(root, fs),
			(root) => fs.remove(root, { recursive: true, force: true }),
		),
	);

const sessionArchivePath = Effect.fn("sessionArchivePath")(function* (
	root: string,
	fs: FileSystem.FileSystem,
) {
	const [sessionDirectory] = yield* fs.readDirectory(`${root}/pi-web-access`);
	assert.ok(sessionDirectory);
	return `${root}/pi-web-access/${sessionDirectory}`;
});

test("archives text, retrieves selections, and evicts beyond twenty responses", () =>
	withRoot((root, fs) =>
		Effect.gen(function* () {
			const archive = yield* openSessionResponseArchive("session-a", root);
			const firstId = yield* archive.archive(["first item", "second item"]);
			assert.deepEqual(yield* archive.retrieve(firstId), {
				status: "found",
				text: "first item\n\n---\n\nsecond item",
				itemCount: 2,
			});
			assert.deepEqual(yield* archive.retrieve(firstId, 1), {
				status: "found",
				text: "second item",
				itemCount: 1,
			});
			assert.deepEqual(yield* archive.retrieve(firstId, 2), {
				status: "item-index-out-of-range",
				itemCount: 2,
			});
			const retainedIds: string[] = [];
			for (let index = 0; index < 20; index += 1) {
				retainedIds.push(yield* archive.archive([`response ${index}`]));
			}
			assert.deepEqual(yield* archive.retrieve(firstId), {
				status: "not-found",
			});
			const archivePath = yield* sessionArchivePath(root, fs);
			const files = yield* fs.readDirectory(archivePath);
			assert.equal(files.length, 20);
			assert.equal((yield* fs.stat(archivePath)).mode & 0o777, 0o700);
			assert.equal(
				(yield* fs.stat(`${archivePath}/${files[0]}`)).mode & 0o777,
				0o600,
			);
			const reopened = yield* openSessionResponseArchive("session-a", root);
			assert.deepEqual(yield* reopened.retrieve(firstId), {
				status: "not-found",
			});
			for (const [index, responseId] of retainedIds.entries()) {
				assert.deepEqual(yield* reopened.retrieve(responseId), {
					status: "found",
					text: `response ${index}`,
					itemCount: 1,
				});
			}
		}),
	));

test("activation removes invalid entries and isolates sessions", () =>
	withRoot((root, fs) =>
		Effect.gen(function* () {
			const archive = yield* openSessionResponseArchive("session-a", root);
			const responseId = yield* archive.archive(["kept"]);
			const archivePath = yield* sessionArchivePath(root, fs);
			yield* fs.writeFileString(`${archivePath}/invalid.json`, "not json\n");
			yield* fs.writeFileString(
				`${archivePath}/legacy.json`,
				'{"id":"legacy","type":"fetch","timestamp":1,"items":[]}\n',
			);
			yield* fs.writeFileString(`${archivePath}/.orphan.tmp`, "partial");
			const reopened = yield* openSessionResponseArchive("session-a", root);
			assert.equal((yield* reopened.retrieve(responseId)).status, "found");
			assert.deepEqual(yield* fs.readDirectory(archivePath), [
				`${responseId}.json`,
			]);
			const otherSession = yield* openSessionResponseArchive("session-b", root);
			assert.deepEqual(yield* otherSession.retrieve(responseId), {
				status: "not-found",
			});
		}),
	));

test("activation rejects a polluted archive directory before reading responses", () =>
	withRoot((root, fs) =>
		Effect.gen(function* () {
			yield* openSessionResponseArchive("session-a", root);
			const archivePath = yield* sessionArchivePath(root, fs);
			for (let index = 0; index < 41; index += 1) {
				yield* fs.writeFileString(
					`${archivePath}/pollution-${index}`,
					"ignored",
				);
			}
			const error = yield* openSessionResponseArchive("session-a", root).pipe(
				Effect.flip,
			);
			assert.match(String(error), /exceeds 40 directory entries/);
		}),
	));

test("archive rejects empty responses and responses with too many items", () =>
	withRoot((root) =>
		Effect.gen(function* () {
			const archive = yield* openSessionResponseArchive("session-a", root);
			assert.match(
				String(yield* archive.archive([]).pipe(Effect.flip)),
				/1-10/,
			);
			assert.match(
				String(
					yield* archive.archive(Array(11).fill("item")).pipe(Effect.flip),
				),
				/1-10/,
			);
		}),
	));
