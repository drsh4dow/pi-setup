// Grades the zeta fixture chunk: pull requests whose ledger rows share a head SHA, written by
// different calls, and a coordinator that edits files with sed -i in each option form.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { grade, placeFixtures, type Rows, readTsv, stubGh } from "./harness.ts";

describe("grading a chunk whose pull requests share head SHAs, and whose coordinator edits files with sed", () => {
  let root = "";
  let stubDir = "";
  let findings: Rows = [];

  before(() => {
    root = mkdtempSync(join(tmpdir(), "coordinator-runs-"));
    stubDir = mkdtempSync(join(tmpdir(), "coordinator-runs-gh-"));
    placeFixtures(root);
    stubGh(stubDir);

    const run = grade(root, stubDir, join(root, "out"), "zeta");

    assert.equal(run.status, 0, run.stderr);
    findings = readTsv(join(root, "out/findings.tsv"));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(stubDir, { recursive: true, force: true });
  });

  const found = (findingClass: string) =>
    findings
      .filter((row) => row.class === findingClass)
      .map((row) => `${row.entry} ${row.detail}`)
      .toSorted();

  const ledger = (line: number) => `${root}/state/demo/implement-chunk/zeta/ledger.tsv:${line}`;

  // z0000001 wrote PR 13's and PR 14's rows at one SHA; z0000002 later changed only PR 14's.
  // z0000003 and z0000004 recorded PR 15's and PR 16's verdicts at one SHA through the chunk CLI.
  test("a ledger row shared by SHA with another PR's row links to the call that wrote this PR's row", () => {
    assert.deepEqual(found("stale-verdict"), [
      `z0000001 acme/app#13 ${ledger(2)}`,
      `z0000002 acme/app#14 ${ledger(3)}`,
      `z0000004 acme/app#16 ${ledger(5)}`,
    ]);
  });

  test("a report-only merge links to the chunk CLI call that recorded its own PR's verdict, not another PR's at the same SHA", () => {
    assert.deepEqual(found("report-only-merge"), [
      `z0000003 acme/app#15 ${"9".repeat(40)} ${ledger(4)}`,
    ]);
  });

  test("counts a sed -i write once whether its script is attached to -e or --expression or a separate argument", () => {
    assert.deepEqual(
      found("root-edit").filter((row) => !row.startsWith("z0000008 ")),
      [
        `z0000005 ${root}/work/src/attached-e.txt`,
        `z0000006 ${root}/work/src/attached-expression.txt`,
        `z0000007 ${root}/work/src/separate-e.txt`,
      ],
    );
  });

  test("counts a write the command names in a branch that may not run, as an upper bound", () => {
    assert.deepEqual(
      found("root-edit").filter((row) => row.startsWith("z0000008 ")),
      [`z0000008 ${root}/work/src/never-written.txt`],
    );
  });
});
