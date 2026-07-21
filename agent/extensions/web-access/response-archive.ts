import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  opendir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, SynchronizedRef } from "effect";
import { asError, type WebAccessError, webAccessError } from "./errors.ts";

const MAX_ARCHIVED_RESPONSES = 20;
const MAX_ARCHIVE_DIRECTORY_ENTRIES = MAX_ARCHIVED_RESPONSES * 2;
const MAX_ARCHIVED_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_ITEMS_PER_RESPONSE = 10;
const ITEM_SEPARATOR = "\n\n---\n\n";

interface ArchivedResponse {
  id: string;
  createdAt: number;
  items: string[];
}

export type ArchiveLookup =
  | { status: "found"; text: string; itemCount: number }
  | { status: "not-found" }
  | { status: "item-index-out-of-range"; itemCount: number };

export interface SessionResponseArchive {
  archive(items: readonly string[]): Effect.Effect<string, WebAccessError>;
  retrieve(id: string, itemIndex?: number): Effect.Effect<ArchiveLookup>;
}

function io<A>(operation: () => Promise<A>): Effect.Effect<A, WebAccessError> {
  return Effect.tryPromise({ try: operation, catch: asError });
}

function directoryFor(sessionId: string, root: string): string {
  const id = createHash("sha256").update(sessionId).digest("hex");
  return join(root, "pi-web-access", id);
}

function isArchivedResponse(
  value: unknown,
  expectedId: string,
): value is ArchivedResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Record<string, unknown>;
  return (
    response.id === expectedId &&
    typeof response.createdAt === "number" &&
    Number.isFinite(response.createdAt) &&
    Array.isArray(response.items) &&
    response.items.length > 0 &&
    response.items.length <= MAX_ITEMS_PER_RESPONSE &&
    response.items.every((item) => typeof item === "string")
  );
}

function discard(path: string): Effect.Effect<void> {
  return io(() => rm(path, { force: true })).pipe(Effect.ignore);
}

async function listDirectory(directory: string): Promise<string[]> {
  const filenames: string[] = [];
  const entries = await opendir(directory);
  for await (const entry of entries) {
    if (filenames.length === MAX_ARCHIVE_DIRECTORY_ENTRIES) {
      throw webAccessError(
        `Session Response Archive exceeds ${MAX_ARCHIVE_DIRECTORY_ENTRIES} directory entries`,
      );
    }
    filenames.push(entry.name);
  }
  return filenames;
}

async function readResponseFile(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const metadata = await file.stat();
    if (metadata.size > MAX_ARCHIVED_RESPONSE_BYTES) {
      throw webAccessError("Archived response exceeds the file-size limit");
    }
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

function loadResponse(
  directory: string,
  filename: string,
): Effect.Effect<ArchivedResponse | null> {
  const path = join(directory, filename);
  const expectedId = filename.slice(0, -".json".length);
  return Effect.gen(function* () {
    const value = yield* io(() => readResponseFile(path)).pipe(
      Effect.flatMap((content) =>
        Effect.try({
          try: () => JSON.parse(content) as unknown,
          catch: asError,
        }),
      ),
      Effect.orElseSucceed(() => null),
    );
    if (isArchivedResponse(value, expectedId)) return value;
    yield* discard(path);
    return null;
  });
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

function removeResponses(
  directory: string,
  responses: ArchivedResponse[],
): Effect.Effect<void, WebAccessError> {
  return Effect.forEach(
    responses,
    (response) =>
      io(() => rm(join(directory, `${response.id}.json`), { force: true })),
    { discard: true },
  );
}

function persistResponse(
  directory: string,
  response: ArchivedResponse,
): Effect.Effect<void, WebAccessError> {
  return Effect.gen(function* () {
    const target = join(directory, `${response.id}.json`);
    const temporary = join(directory, `.${response.id}.${randomUUID()}.tmp`);
    const content = yield* Effect.try({
      try: () => `${JSON.stringify(response)}\n`,
      catch: asError,
    });
    if (Buffer.byteLength(content) > MAX_ARCHIVED_RESPONSE_BYTES) {
      return yield* webAccessError(
        "Archived response exceeds the file-size limit",
      );
    }
    yield* Effect.gen(function* () {
      yield* io(() =>
        writeFile(temporary, content, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        }),
      );
      yield* io(() => rename(temporary, target));
      yield* io(() => chmod(target, 0o600));
    }).pipe(Effect.ensuring(discard(temporary)));
  });
}

export function openSessionResponseArchive(
  sessionId: string,
  root = tmpdir(),
): Effect.Effect<SessionResponseArchive, WebAccessError> {
  return Effect.gen(function* () {
    const directory = directoryFor(sessionId, root);
    yield* io(() => mkdir(directory, { recursive: true, mode: 0o700 }));
    yield* io(() => chmod(directory, 0o700));

    const files = yield* io(() => listDirectory(directory));
    yield* Effect.forEach(
      files.filter((filename) => filename.endsWith(".tmp")),
      (filename) => discard(join(directory, filename)),
      { discard: true },
    );
    const loadedResponses = yield* Effect.forEach(
      files.filter((filename) => filename.endsWith(".json")),
      (filename) => loadResponse(directory, filename),
    );
    const loaded = new Map<string, ArchivedResponse>();
    for (const response of loadedResponses) {
      if (response) loaded.set(response.id, response);
    }
    const initial = evictOldest(loaded);
    yield* removeResponses(directory, initial.evicted);
    const responses = SynchronizedRef.makeUnsafe(initial.responses);

    return {
      archive(items) {
        if (items.length === 0 || items.length > MAX_ITEMS_PER_RESPONSE) {
          return Effect.fail(
            webAccessError(
              `A response must contain 1-${MAX_ITEMS_PER_RESPONSE} text items`,
            ),
          );
        }
        const responseId = randomUUID();
        const target = join(directory, `${responseId}.json`);
        return SynchronizedRef.updateEffect(responses, (current) =>
          Effect.gen(function* () {
            const newestCreatedAt = Math.max(
              0,
              ...[...current.values()].map((response) => response.createdAt),
            );
            const response: ArchivedResponse = {
              id: responseId,
              createdAt: Math.max(Date.now(), newestCreatedAt + 1),
              items: [...items],
            };
            yield* persistResponse(directory, response);
            const withResponse = new Map(current);
            withResponse.set(response.id, response);
            const next = evictOldest(withResponse);
            yield* removeResponses(directory, next.evicted);
            return next.responses;
          }),
        ).pipe(
          Effect.as(responseId),
          Effect.catch((error) =>
            discard(target).pipe(Effect.andThen(Effect.fail(asError(error)))),
          ),
        );
      },
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
}
