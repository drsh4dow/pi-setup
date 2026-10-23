import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { trackCheckouts } from "../index.ts";

function makeCheckout(path: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, ".git"), "gitdir: /synthetic/repo/.git/worktrees/branch\n");
}

test("reports each checkout once, and again after it is removed and recreated", (t) => {
  const root = mkdtempSync(join(tmpdir(), "herdr-worktrees-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const existing = join(root, "ui", "existing-branch");
  const flat = join(root, "infra-pe-1234");
  const nested = join(root, "ui", "new-branch");

  makeCheckout(existing);
  const nextNewCheckouts = trackCheckouts(root);

  makeCheckout(flat);
  makeCheckout(nested);
  mkdirSync(join(root, "notes", "draft"), { recursive: true });

  assert.deepEqual(nextNewCheckouts().toSorted(), [flat, nested]);
  assert.deepEqual(nextNewCheckouts(), []);

  rmSync(nested, { recursive: true });
  assert.deepEqual(nextNewCheckouts(), []);

  makeCheckout(nested);
  assert.deepEqual(nextNewCheckouts(), [nested]);
});

test("finds nothing when the worktrees directory does not exist", () => {
  const nextNewCheckouts = trackCheckouts(join(tmpdir(), "herdr-worktrees-missing"));

  assert.deepEqual(nextNewCheckouts(), []);
});
