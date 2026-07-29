import assert from "node:assert/strict";
import { test } from "node:test";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, FileSystem } from "effect";
import { openSessionResponseArchive } from "../response-archive.ts";

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
	Effect.runPromise(effect.pipe(Effect.provide(BunFileSystem.layer)));

const withRoot = <A>(
	use: (root: string, fs: FileSystem.FileSystem) => Promise<A>,
): Promise<A> =>
	run(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const root = yield* fs.makeTempDirectory({
				prefix: "pi-web-access-archive-test-",
			});
			return yield* Effect.tryPromise(() => use(root, fs)).pipe(
				Effect.ensuring(
					fs.remove(root, { recursive: true, force: true }).pipe(Effect.ignore),
				),
			);
		}),
	);

const sessionArchivePath = async (root: string, fs: FileSystem.FileSystem) => {
	const [sessionDirectory] = await Effect.runPromise(
		fs.readDirectory(`${root}/pi-web-access`),
	);
	assert.ok(sessionDirectory);
	return `${root}/pi-web-access/${sessionDirectory}`;
};

test("archives text, retrieves selections, and evicts beyond twenty responses", () =>
	withRoot(async (root, fs) => {
		const archive = await Effect.runPromise(
			openSessionResponseArchive("session-a", root),
		);
		const firstId = await Effect.runPromise(
			archive.archive(["first item", "second item"]),
		);
		assert.deepEqual(await Effect.runPromise(archive.retrieve(firstId)), {
			status: "found",
			text: "first item\n\n---\n\nsecond item",
			itemCount: 2,
		});
		assert.deepEqual(await Effect.runPromise(archive.retrieve(firstId, 1)), {
			status: "found",
			text: "second item",
			itemCount: 1,
		});
		assert.deepEqual(await Effect.runPromise(archive.retrieve(firstId, 2)), {
			status: "item-index-out-of-range",
			itemCount: 2,
		});

		const retainedIds: string[] = [];
		for (let index = 0; index < 20; index += 1) {
			retainedIds.push(
				await Effect.runPromise(archive.archive([`response ${index}`])),
			);
		}
		assert.deepEqual(await Effect.runPromise(archive.retrieve(firstId)), {
			status: "not-found",
		});

		const archivePath = await sessionArchivePath(root, fs);
		const files = await Effect.runPromise(fs.readDirectory(archivePath));
		assert.equal(files.length, 20);
		assert.equal(
			(await Effect.runPromise(fs.stat(archivePath))).mode & 0o777,
			0o700,
		);
		assert.equal(
			(await Effect.runPromise(fs.stat(`${archivePath}/${files[0]}`))).mode &
				0o777,
			0o600,
		);

		const reopened = await Effect.runPromise(
			openSessionResponseArchive("session-a", root),
		);
		assert.deepEqual(await Effect.runPromise(reopened.retrieve(firstId)), {
			status: "not-found",
		});
		for (const [index, responseId] of retainedIds.entries()) {
			assert.deepEqual(await Effect.runPromise(reopened.retrieve(responseId)), {
				status: "found",
				text: `response ${index}`,
				itemCount: 1,
			});
		}
	}));

test("activation removes invalid entries and isolates sessions", () =>
	withRoot(async (root, fs) => {
		const archive = await Effect.runPromise(
			openSessionResponseArchive("session-a", root),
		);
		const responseId = await Effect.runPromise(archive.archive(["kept"]));
		const archivePath = await sessionArchivePath(root, fs);
		await Effect.runPromise(
			fs.writeFileString(`${archivePath}/invalid.json`, "not json\n"),
		);
		await Effect.runPromise(
			fs.writeFileString(
				`${archivePath}/legacy.json`,
				'{"id":"legacy","type":"fetch","timestamp":1,"items":[]}\n',
			),
		);
		await Effect.runPromise(
			fs.writeFileString(`${archivePath}/.orphan.tmp`, "partial"),
		);

		const reopened = await Effect.runPromise(
			openSessionResponseArchive("session-a", root),
		);
		assert.equal(
			(await Effect.runPromise(reopened.retrieve(responseId))).status,
			"found",
		);
		assert.deepEqual(await Effect.runPromise(fs.readDirectory(archivePath)), [
			`${responseId}.json`,
		]);

		const otherSession = await Effect.runPromise(
			openSessionResponseArchive("session-b", root),
		);
		assert.deepEqual(
			await Effect.runPromise(otherSession.retrieve(responseId)),
			{ status: "not-found" },
		);
	}));

test("activation rejects a polluted archive directory before reading responses", () =>
	withRoot(async (root, fs) => {
		await Effect.runPromise(openSessionResponseArchive("session-a", root));
		const archivePath = await sessionArchivePath(root, fs);
		for (let index = 0; index < 41; index += 1) {
			await Effect.runPromise(
				fs.writeFileString(`${archivePath}/pollution-${index}`, "ignored"),
			);
		}
		await assert.rejects(
			Effect.runPromise(openSessionResponseArchive("session-a", root)),
			/exceeds 40 directory entries/,
		);
	}));

test("archive rejects empty responses and responses with too many items", () =>
	withRoot(async (root) => {
		const archive = await Effect.runPromise(
			openSessionResponseArchive("session-a", root),
		);
		await assert.rejects(Effect.runPromise(archive.archive([])), /1-10/);
		await assert.rejects(
			Effect.runPromise(archive.archive(Array(11).fill("item"))),
			/1-10/,
		);
	}));
