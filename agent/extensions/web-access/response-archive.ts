import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import {
	Clock,
	Crypto,
	Effect,
	FileSystem,
	Layer,
	Path,
	PlatformError,
	Schema,
	SynchronizedRef,
} from "effect";
import { asError, type WebAccessError, webAccessError } from "./errors.ts";

const MAX_ARCHIVED_RESPONSES = 20;
const MAX_FUTURE_SKEW_MILLIS = 20;
const MAX_ARCHIVE_DIRECTORY_ENTRIES = MAX_ARCHIVED_RESPONSES * 2;
const MAX_ARCHIVED_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_ITEMS_PER_RESPONSE = 10;
const ARCHIVE_TTL_MILLIS = 24 * 60 * 60 * 1000;
const ITEM_SEPARATOR = "\n\n---\n\n";

const ArchivedResponse = Schema.Struct({
	id: Schema.String,
	createdAt: Schema.Finite,
	items: Schema.Array(Schema.String).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(MAX_ITEMS_PER_RESPONSE),
	),
});
type ArchivedResponse = typeof ArchivedResponse.Type;
const ArchivedResponseJson = Schema.fromJsonString(ArchivedResponse);

export type ArchiveLookup =
	| { status: "found"; text: string; itemCount: number }
	| { status: "not-found" }
	| { status: "item-index-out-of-range"; itemCount: number };

export interface SessionResponseArchive {
	archive(items: readonly string[]): Effect.Effect<string, WebAccessError>;
	retrieve(id: string, itemIndex?: number): Effect.Effect<ArchiveLookup>;
}

const runtimeLayer = Layer.mergeAll(
	BunFileSystem.layer,
	BunPath.layer,
	BunCrypto.layer,
);

function platformError<A, E, R>(
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, WebAccessError, R> {
	return Effect.mapError(effect, (error) =>
		error instanceof PlatformError.PlatformError && "cause" in error.reason
			? asError(error.reason.cause)
			: asError(error),
	);
}

function discard(fs: FileSystem.FileSystem, path: string): Effect.Effect<void> {
	return fs.remove(path, { force: true }).pipe(Effect.ignore);
}

function evictOldest(responses: Map<string, ArchivedResponse>): {
	responses: Map<string, ArchivedResponse>;
	evicted: ArchivedResponse[];
} {
	const next = new Map(responses);
	const evicted: ArchivedResponse[] = [];
	while (next.size > MAX_ARCHIVED_RESPONSES) {
		const oldest = [...next.values()].sort(
			(left, right) => left.createdAt - right.createdAt,
		)[0];
		if (!oldest) break;
		next.delete(oldest.id);
		evicted.push(oldest);
	}
	return { responses: next, evicted };
}

const openArchive = Effect.fn("openSessionResponseArchive")(function* (
	sessionId: string,
	root: string,
): Effect.fn.Return<
	SessionResponseArchive,
	WebAccessError,
	FileSystem.FileSystem | Path.Path | Crypto.Crypto
> {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const crypto = yield* Crypto.Crypto;
	const digest = yield* platformError(
		crypto.digest("SHA-256", new TextEncoder().encode(sessionId)),
	);
	const directory = path.join(
		root,
		"pi-web-access",
		[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
	);
	yield* platformError(
		fs.makeDirectory(directory, { recursive: true, mode: 0o700 }),
	);
	yield* platformError(fs.chmod(directory, 0o700));

	const files = yield* platformError(fs.readDirectory(directory));
	if (files.length > MAX_ARCHIVE_DIRECTORY_ENTRIES) {
		return yield* webAccessError(
			`Session Response Archive exceeds ${MAX_ARCHIVE_DIRECTORY_ENTRIES} directory entries`,
		);
	}
	yield* Effect.forEach(
		files.filter((filename) => filename.endsWith(".tmp")),
		(filename) => discard(fs, path.join(directory, filename)),
		{ discard: true },
	);
	const now = yield* Clock.currentTimeMillis;
	const loadedResponses = yield* Effect.forEach(
		files.filter((filename) => filename.endsWith(".json")),
		Effect.fn("loadArchivedResponse")(function* (filename) {
			const filePath = path.join(directory, filename);
			const expectedId = filename.slice(0, -".json".length);
			const metadata = yield* fs.stat(filePath).pipe(Effect.option);
			if (
				metadata._tag === "None" ||
				metadata.value.size > BigInt(MAX_ARCHIVED_RESPONSE_BYTES)
			) {
				yield* discard(fs, filePath);
				return null;
			}
			const response = yield* fs
				.readFileString(filePath)
				.pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(ArchivedResponseJson)),
					Effect.option,
				);
			if (
				response._tag === "Some" &&
				response.value.id === expectedId &&
				response.value.createdAt - now <= MAX_FUTURE_SKEW_MILLIS &&
				now - response.value.createdAt <= ARCHIVE_TTL_MILLIS
			) {
				return response.value;
			}
			yield* discard(fs, filePath);
			return null;
		}),
	);
	const loaded = new Map<string, ArchivedResponse>();
	for (const response of loadedResponses) {
		if (response) loaded.set(response.id, response);
	}
	const initial = evictOldest(loaded);
	yield* Effect.forEach(
		initial.evicted,
		(response) =>
			platformError(
				fs.remove(path.join(directory, `${response.id}.json`), { force: true }),
			),
		{ discard: true },
	);
	const responses = SynchronizedRef.makeUnsafe(initial.responses);

	return {
		archive: Effect.fn("SessionResponseArchive.archive")(function* (items) {
			if (items.length === 0 || items.length > MAX_ITEMS_PER_RESPONSE) {
				return yield* webAccessError(
					`A response must contain 1-${MAX_ITEMS_PER_RESPONSE} text items`,
				);
			}
			const responseId = yield* platformError(crypto.randomUUIDv4);
			const target = path.join(directory, `${responseId}.json`);
			return yield* SynchronizedRef.updateEffect(responses, (current) =>
				Effect.gen(function* () {
					const newestCreatedAt = Math.max(
						0,
						...[...current.values()].map((response) => response.createdAt),
					);
					const currentTime = yield* Clock.currentTimeMillis;
					const response: ArchivedResponse = {
						id: responseId,
						createdAt: Math.max(currentTime, newestCreatedAt + 1),
						items: [...items],
					};
					const content = yield* Schema.encodeEffect(ArchivedResponseJson)(
						response,
					).pipe(
						Effect.mapError(asError),
						Effect.map((json) => `${json}\n`),
					);
					if (
						new TextEncoder().encode(content).byteLength >
						MAX_ARCHIVED_RESPONSE_BYTES
					) {
						return yield* webAccessError(
							"Archived response exceeds the file-size limit",
						);
					}
					const temporary = path.join(
						directory,
						`.${responseId}.${yield* platformError(crypto.randomUUIDv4)}.tmp`,
					);
					yield* Effect.gen(function* () {
						yield* platformError(
							fs.writeFileString(temporary, content, {
								flag: "wx",
								mode: 0o600,
							}),
						);
						yield* platformError(fs.rename(temporary, target));
						yield* platformError(fs.chmod(target, 0o600));
					}).pipe(Effect.ensuring(discard(fs, temporary)));
					const withResponse = new Map(current);
					withResponse.set(response.id, response);
					const next = evictOldest(withResponse);
					yield* Effect.forEach(
						next.evicted,
						(evicted) =>
							platformError(
								fs.remove(path.join(directory, `${evicted.id}.json`), {
									force: true,
								}),
							),
						{ discard: true },
					);
					return next.responses;
				}),
			).pipe(
				Effect.as(responseId),
				Effect.catch((error) =>
					discard(fs, target).pipe(Effect.andThen(Effect.fail(asError(error)))),
				),
			);
		}),
		retrieve(id, itemIndex) {
			return SynchronizedRef.get(responses).pipe(
				Effect.map((current): ArchiveLookup => {
					const response = current.get(id);
					if (!response) return { status: "not-found" };
					if (
						itemIndex !== undefined &&
						(!Number.isInteger(itemIndex) ||
							itemIndex < 0 ||
							itemIndex >= response.items.length)
					) {
						return {
							status: "item-index-out-of-range",
							itemCount: response.items.length,
						};
					}
					const items =
						itemIndex === undefined
							? response.items
							: [response.items[itemIndex]];
					return {
						status: "found",
						text: items.join(ITEM_SEPARATOR),
						itemCount: items.length,
					};
				}),
			);
		},
	};
});

export function openSessionResponseArchive(
	sessionId: string,
	root = "/tmp",
): Effect.Effect<SessionResponseArchive, WebAccessError> {
	return openArchive(sessionId, root).pipe(Effect.provide(runtimeLayer));
}
