import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
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
import type { StoredResponse } from "./types.ts";

const MAX_RESPONSES = 20;
const cache = new Map<string, StoredResponse>();
let cacheDirectory: string | null = null;
let storageOperation: Promise<void> = Promise.resolve();

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = storageOperation.then(operation, operation);
  storageOperation = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
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

async function removeResponse(id: string): Promise<void> {
  if (!cacheDirectory) return;
  await rm(join(cacheDirectory, `${id}.json`), { force: true });
}

function evictOldest(): StoredResponse[] {
  const evicted: StoredResponse[] = [];
  while (cache.size > MAX_RESPONSES) {
    const oldest = [...cache.values()].sort(
      (left, right) => left.timestamp - right.timestamp,
    )[0];
    if (!oldest) break;
    cache.delete(oldest.id);
    evicted.push(oldest);
  }
  return evicted;
}

export function createResponseId(): string {
  return randomUUID();
}

export async function initializeStorage(
  sessionId: string,
  root = tmpdir(),
): Promise<void> {
  await serialize(async () => {
    cache.clear();
    cacheDirectory = directoryFor(sessionId, root);
    await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
    await chmod(cacheDirectory, 0o700);

    const files = (await readdir(cacheDirectory)).filter((name) =>
      name.endsWith(".json"),
    );
    for (const file of files) {
      try {
        const parsed = JSON.parse(
          await readFile(join(cacheDirectory, file), "utf8"),
        ) as unknown;
        if (isStoredResponse(parsed)) cache.set(parsed.id, parsed);
      } catch {
        await rm(join(cacheDirectory, file), { force: true });
      }
    }

    const evicted = evictOldest();
    await Promise.all(evicted.map((response) => removeResponse(response.id)));
  });
}

export async function storeResponse(response: StoredResponse): Promise<void> {
  await serialize(async () => {
    if (!cacheDirectory) {
      throw new Error("Web access storage is not initialized");
    }

    const target = join(cacheDirectory, `${response.id}.json`);
    const temporary = join(
      cacheDirectory,
      `.${response.id}.${randomUUID()}.tmp`,
    );
    await writeFile(temporary, `${JSON.stringify(response)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, target);
    await chmod(target, 0o600);

    cache.set(response.id, response);
    const evicted = evictOldest();
    await Promise.all(evicted.map((item) => removeResponse(item.id)));
  });
}

export function getResponse(id: string): StoredResponse | null {
  return cache.get(id) ?? null;
}

export async function storageIsReady(): Promise<boolean> {
  if (!cacheDirectory) return false;
  try {
    await access(cacheDirectory, constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
