import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import { getResponse, initializeStorage, storeResponse } from "../storage.ts";

test("temporary storage persists and evicts beyond twenty responses", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-access-storage-test-"));
  try {
    await Effect.runPromise(initializeStorage("session-a", root));
    for (let index = 0; index < 21; index += 1) {
      await Effect.runPromise(
        storeResponse({
          id: `response-${index}`,
          type: "fetch",
          timestamp: index,
          items: [
            {
              url: `https://example.com/${index}`,
              title: String(index),
              content: "content",
              error: null,
            },
          ],
        }),
      );
    }

    assert.equal(await Effect.runPromise(getResponse("response-0")), null);
    assert.equal(
      (await Effect.runPromise(getResponse("response-20")))?.type,
      "fetch",
    );

    const [sessionDirectory] = await readdir(join(root, "pi-web-access"));
    const cachePath = join(root, "pi-web-access", sessionDirectory);
    const files = await readdir(cachePath);
    assert.equal(files.length, 20);
    assert.equal((await stat(cachePath)).mode & 0o777, 0o700);
    assert.equal((await stat(join(cachePath, files[0]))).mode & 0o777, 0o600);

    await Effect.runPromise(initializeStorage("session-a", root));
    assert.equal(await Effect.runPromise(getResponse("response-0")), null);
    assert.equal(
      (await Effect.runPromise(getResponse("response-20")))?.items[0].content,
      "content",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
