import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import { openSessionResponseArchive } from "../response-archive.ts";

test("archives text, retrieves selections, and evicts beyond twenty responses", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-access-archive-test-"));
  try {
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

    const [sessionDirectory] = await readdir(join(root, "pi-web-access"));
    const archivePath = join(root, "pi-web-access", sessionDirectory);
    const files = await readdir(archivePath);
    assert.equal(files.length, 20);
    assert.equal((await stat(archivePath)).mode & 0o777, 0o700);
    assert.equal((await stat(join(archivePath, files[0]))).mode & 0o777, 0o600);

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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("activation removes invalid entries and isolates sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-access-archive-test-"));
  try {
    const archive = await Effect.runPromise(
      openSessionResponseArchive("session-a", root),
    );
    const responseId = await Effect.runPromise(archive.archive(["kept"]));
    const [sessionDirectory] = await readdir(join(root, "pi-web-access"));
    const archivePath = join(root, "pi-web-access", sessionDirectory);
    await writeFile(join(archivePath, "invalid.json"), "not json\n");
    await writeFile(
      join(archivePath, "legacy.json"),
      `${JSON.stringify({ id: "legacy", type: "fetch", timestamp: 1, items: [] })}\n`,
    );
    await writeFile(join(archivePath, ".orphan.tmp"), "partial");

    const reopened = await Effect.runPromise(
      openSessionResponseArchive("session-a", root),
    );
    assert.equal(
      (await Effect.runPromise(reopened.retrieve(responseId))).status,
      "found",
    );
    assert.deepEqual(await readdir(archivePath), [`${responseId}.json`]);

    const otherSession = await Effect.runPromise(
      openSessionResponseArchive("session-b", root),
    );
    assert.deepEqual(
      await Effect.runPromise(otherSession.retrieve(responseId)),
      { status: "not-found" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("activation rejects a polluted archive directory before reading responses", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-access-archive-test-"));
  try {
    await Effect.runPromise(openSessionResponseArchive("session-a", root));
    const [sessionDirectory] = await readdir(join(root, "pi-web-access"));
    const archivePath = join(root, "pi-web-access", sessionDirectory);
    for (let index = 0; index < 41; index += 1) {
      await writeFile(join(archivePath, `pollution-${index}`), "ignored");
    }
    await assert.rejects(
      Effect.runPromise(openSessionResponseArchive("session-a", root)),
      /exceeds 40 directory entries/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archive rejects empty responses and responses with too many items", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-access-archive-test-"));
  try {
    const archive = await Effect.runPromise(
      openSessionResponseArchive("session-a", root),
    );
    await assert.rejects(Effect.runPromise(archive.archive([])), /1-10/);
    await assert.rejects(
      Effect.runPromise(archive.archive(Array(11).fill("item"))),
      /1-10/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
