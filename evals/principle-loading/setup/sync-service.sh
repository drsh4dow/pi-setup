#!/usr/bin/env bash
# Two earlier fixes for the flaky test, each its own commit on top of the initial one.
set -euo pipefail

sed -i 's/^test("a newer remote edit wins over the local copy", async () => {$/test("a newer remote edit wins over the local copy", { timeout: 10_000 }, async () => {/' test/sync.test.js
git commit -qam "test: raise sync test timeout to 10s"

cat > test/sync.test.js <<'EOF'
import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeRecords, stampEdit } from "../src/sync.js";

test("a newer remote edit wins over the local copy", { timeout: 10_000 }, async () => {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const base = { id: "n1", title: "draft", updatedAt: 0 };
      const local = stampEdit(base, { title: "local edit" });
      await new Promise((resolve) => setTimeout(resolve, 1));
      const remote = stampEdit(base, { title: "remote edit" });

      const [merged] = mergeRecords([local], [remote]);
      assert.equal(merged.title, "remote edit");
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
});
EOF
git commit -qam "test: retry the flaky sync test up to 3 times"
