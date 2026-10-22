import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeRecords, stampEdit } from "../src/sync.js";

test("a newer remote edit wins over the local copy", async () => {
  const base = { id: "n1", title: "draft", updatedAt: 0 };
  const local = stampEdit(base, { title: "local edit" });
  await new Promise((resolve) => setTimeout(resolve, 1));
  const remote = stampEdit(base, { title: "remote edit" });

  const [merged] = mergeRecords([local], [remote]);
  assert.equal(merged.title, "remote edit");
});
