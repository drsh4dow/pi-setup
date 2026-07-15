import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, SynchronizedRef } from "effect";
import { asError } from "./errors.ts";
import type { StoredResponse } from "./types.ts";

const MAX_RESPONSES = 20;

interface StorageState {
  cache: Map<string, StoredResponse>;
  directory: string | null;
}

const storage = SynchronizedRef.makeUnsafe<StorageState>({
  cache: new Map(),
  directory: null,
});

function io<A>(operation: () => Promise<A>): Effect.Effect<A, Error> {
  return Effect.tryPromise({ try: operation, catch: asError });
}

function isStoredResponse(value: unknown): value is StoredResponse {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    (item.type === "search" || item.type === "fetch") &&
    typeof item.timestamp === "number" &&
    Array.isArray(item.items)
  );
}

function directoryFor(sessionId: string, root: string): string {
  const id = createHash("sha256").update(sessionId).digest("hex");
  return join(root, "pi-web-access", id);
}

function evictOldest(cache: Map<string, StoredResponse>): {
  cache: Map<string, StoredResponse>;
  evicted: StoredResponse[];
} {
  const next = new Map(cache);
  const evicted: StoredResponse[] = [];
  while (next.size > MAX_RESPONSES) {
    const oldest = [...next.values()].sort(
      (left, right) => left.timestamp - right.timestamp,
    )[0];
    if (!oldest) break;
    next.delete(oldest.id);
    evicted.push(oldest);
  }
  return { cache: next, evicted };
}

function removeResponses(
  directory: string,
  responses: StoredResponse[],
): Effect.Effect<void, Error> {
  return Effect.forEach(
    responses,
    (response) =>
      io(() => rm(join(directory, `${response.id}.json`), { force: true })),
    { discard: true },
  );
}

export function createResponseId(): string {
  return randomUUID();
}

export function initializeStorage(
  sessionId: string,
  root = tmpdir(),
): Effect.Effect<void, Error> {
  return SynchronizedRef.updateEffect(storage, () =>
    Effect.gen(function* () {
      const directory = directoryFor(sessionId, root);
      yield* io(() => mkdir(directory, { recursive: true, mode: 0o700 }));
      yield* io(() => chmod(directory, 0o700));

      const files = (yield* io(() => readdir(directory))).filter((name) =>
        name.endsWith(".json"),
      );
      const loaded = new Map<string, StoredResponse>();
      yield* Effect.forEach(
        files,
        (file) =>
          Effect.gen(function* () {
            const path = join(directory, file);
            const parsed = yield* io(() => readFile(path, "utf8")).pipe(
              Effect.flatMap((content) =>
                Effect.try({
                  try: () => JSON.parse(content) as unknown,
                  catch: asError,
                }),
              ),
              Effect.catch(() =>
                io(() => rm(path, { force: true })).pipe(Effect.as(null)),
              ),
            );
            if (parsed && isStoredResponse(parsed))
              loaded.set(parsed.id, parsed);
          }),
        { discard: true },
      );

      const { cache, evicted } = evictOldest(loaded);
      yield* removeResponses(directory, evicted);
      return { cache, directory };
    }),
  ).pipe(Effect.asVoid);
}

export function storeResponse(
  response: StoredResponse,
): Effect.Effect<void, Error> {
  return SynchronizedRef.updateEffect(storage, (state) =>
    Effect.gen(function* () {
      if (!state.directory) {
        return yield* Effect.fail(
          new Error("Web access storage is not initialized"),
        );
      }

      const target = join(state.directory, `${response.id}.json`);
      const temporary = join(
        state.directory,
        `.${response.id}.${randomUUID()}.tmp`,
      );
      yield* Effect.gen(function* () {
        yield* io(() =>
          writeFile(temporary, `${JSON.stringify(response)}\n`, {
            encoding: "utf8",
            mode: 0o600,
            flag: "wx",
          }),
        );
        yield* io(() => rename(temporary, target));
        yield* io(() => chmod(target, 0o600));
      }).pipe(
        Effect.ensuring(
          io(() => rm(temporary, { force: true })).pipe(
            Effect.catch(() => Effect.void),
          ),
        ),
      );

      const withResponse = new Map(state.cache);
      withResponse.set(response.id, response);
      const { cache, evicted } = evictOldest(withResponse);
      yield* removeResponses(state.directory, evicted);
      return { cache, directory: state.directory };
    }),
  ).pipe(Effect.asVoid);
}

export function getResponse(id: string): Effect.Effect<StoredResponse | null> {
  return SynchronizedRef.get(storage).pipe(
    Effect.map((state) => state.cache.get(id) ?? null),
  );
}
