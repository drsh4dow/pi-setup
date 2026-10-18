import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

const checker = new URL("../../skills/show-me-your-work/scripts/check-evidence.ts", import.meta.url)
  .pathname;

const header = "ts\tphase\tdecision\twhy\tevidence\tresult\n";

function directory(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "check-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  return root;
}

function writeFiles(root: string, paths: readonly string[]) {
  for (const path of paths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), "");
  }
}

function repository(t: TestContext) {
  const root = directory(t);

  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "README.md"), "one\ntwo\n");
  writeFileSync(join(root, "LICENSE"), "MIT\n");
  writeFileSync(join(root, "+server.ts"), "export {};\n");
  writeFileSync(join(root, "docs/real.md"), "a\nb\nc\nd\n");
  execFileSync("git", ["init", "--quiet"], { cwd: root });

  return root;
}

function writeLog(root: string, evidence: string[]) {
  const rows = evidence.map(
    (cell) => `2026-05-24T09:02:00Z\tbuild\tdid it\tbecause\t${cell}\tok\n`,
  );

  writeFileSync(join(root, "decisions.tsv"), header + rows.join(""));
}

function run(cwd: string, args: string[]) {
  return spawnSync(checker, args, { cwd, encoding: "utf8" });
}

test("flags missing evidence and passes an existing file, resolving from the repository root", (t) => {
  const root = repository(t);
  const docs = join(root, "docs");

  writeLog(root, ["docs/missing.md:12"]);
  const missing = run(docs, ["../decisions.tsv"]);
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, "../decisions.tsv:2: docs/missing.md:12 (no such file)\n");

  writeLog(root, ["docs/real.md"]);
  const existing = run(docs, ["../decisions.tsv"]);
  assert.equal(existing.status, 0, existing.stdout);
  assert.equal(existing.stdout, "");
});

test("skips tokens that are not pointers and accepts pointers written in prose", (t) => {
  const root = repository(t);

  writeLog(root, [
    "N/A",
    "pass/fail",
    "origin/main",
    "drsh4dow/pi-setup#30",
    "example.com",
    "https://github.com/drsh4dow/pi-setup/pull/40",
    "commit 3a9f1c2, pixel-diff 0",
    "ran at 12:30 and 2026-05-24T09:02:00",
    "`docs/real.md:3`",
    "docs/real.md#L2-L4",
    "README.md#usage",
    "docs/real.md,README.md:2",
    "docs/real.md;README.md, LICENSE:1",
    "see docs/real.md:4.",
    "'+server.ts:1",
    `${root}/README.md:1:3`,
  ]);

  const result = run(root, ["decisions.tsv"]);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("flags pointers that do not resolve, including bare names and bad line ranges", (t) => {
  const root = repository(t);
  const overflow = "12345678901234567890123";

  writeLog(root, [
    "LICENSE:999999",
    "see docs/missing.md:12",
    "README.md:0",
    "README.md:999999-1",
    `README.md:${overflow}`,
    "docs/real.md#L3-L5",
    "'@docs/gone.md",
    "README.md:999:1",
  ]);

  const result = run(root, ["decisions.tsv"]);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(result.stdout.trimEnd().split("\n"), [
    "decisions.tsv:2: LICENSE:999999 (line out of range, file has 1 lines)",
    "decisions.tsv:3: docs/missing.md:12 (no such file)",
    "decisions.tsv:4: README.md:0 (line out of range, file has 2 lines)",
    "decisions.tsv:5: README.md:999999-1 (range is reversed)",
    `decisions.tsv:6: README.md:${overflow} (line out of range, file has 2 lines)`,
    "decisions.tsv:7: docs/real.md#L3-L5 (line out of range, file has 4 lines)",
    "decisions.tsv:8: @docs/gone.md (no such file)",
    "decisions.tsv:9: README.md:999:1 (line out of range, file has 2 lines)",
  ]);
});

test("checks only the rows from first-line on", (t) => {
  const root = repository(t);
  writeLog(root, ["docs/missing.md", "docs/real.md"]);

  const everyRow = run(root, ["decisions.tsv"]);
  assert.equal(everyRow.status, 1);
  assert.equal(everyRow.stdout, "decisions.tsv:2: docs/missing.md (no such file)\n");

  const thisRun = run(root, ["decisions.tsv", "3"]);
  assert.equal(thisRun.status, 0, thisRun.stdout);
  assert.equal(thisRun.stdout, "");

  const invalid = run(root, ["decisions.tsv", "0"]);
  assert.equal(invalid.status, 64);
  assert.match(invalid.stderr, /first-line must be a positive line number, got 0/);
});

test("resolves relative paths from the log directory, the repository root, and the working directory", (t) => {
  const root = repository(t);
  const state = directory(t);
  const log = join(state, "decisions.tsv");
  writeFiles(state, ["brief.md", "swarm/report-6.md"]);
  writeFiles(root, ["docs/notes.md"]);
  writeLog(state, ["brief.md", "docs/real.md", "./notes.md", "report-6.md", "gone.md"]);

  const result = run(join(root, "docs"), [log]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, `${log}:6: gone.md (no such file)\n`);
});

test("resolves a bare name to a tracked file with that name and checks the range there", (t) => {
  const root = repository(t);
  mkdirSync(join(root, "dist/auth"), { recursive: true });
  writeFileSync(join(root, "dist/auth/helpers.js"), "x\n".repeat(52));
  execFileSync("git", ["add", "."], { cwd: root });
  writeLog(root, ["helpers.js:38-50", "helpers.js:38-60"]);

  const result = run(root, ["decisions.tsv"]);
  assert.equal(result.status, 1);
  assert.equal(
    result.stdout,
    "decisions.tsv:3: helpers.js:38-60 (line out of range, file has 52 lines)\n",
  );
});

test("resolves a short form beside an earlier pointer in the same cell", (t) => {
  const root = repository(t);
  writeFiles(root, [
    "runs/a/review-a.md",
    "runs/a/review-b.md",
    "runs/b/notes.md",
    "runs/c/sub/r1.md",
  ]);
  writeLog(root, [
    `${root}/runs/a/review-a.md, review-b.md, b/notes.md, review-c.md`,
    "review-b.md",
    `${root}/runs/c/sub/, r1.md`,
  ]);

  const result = run(root, ["decisions.tsv"]);
  assert.equal(result.status, 1);
  assert.deepEqual(result.stdout.trimEnd().split("\n"), [
    "decisions.tsv:2: review-c.md (no such file)",
    "decisions.tsv:3: review-b.md (no such file)",
  ]);
});

test("passes a glob that matches a path and flags one that matches nothing", (t) => {
  const root = repository(t);
  writeLog(root, ["docs/*.md", `${root}/docs/r?al.md`, "docs/*.nope"]);

  const result = run(root, ["decisions.tsv"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "decisions.tsv:4: docs/*.nope (no such file)\n");
});

test("matches a ** glob within one directory level", (t) => {
  const root = repository(t);
  writeFiles(root, ["deep/a/b/buried.md"]);
  writeLog(root, ["**/real.md", "**/buried.md"]);

  const result = run(root, ["decisions.tsv"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "decisions.tsv:3: **/buried.md (no such file)\n");
});

test("reads brackets in an existing path and in the log's directory literally", (t) => {
  const root = repository(t);
  const logDir = join(root, "b[1]");
  writeFiles(root, ["b[1]/r1.md"]);
  mkdirSync(join(root, "app/[id]"), { recursive: true });
  writeFileSync(join(root, "app/[id]/page.tsx"), "export {};\n");
  writeLog(root, ["app/[id]/page.tsx", "app/[id]/page.tsx:1"]);
  writeLog(logDir, ["r*.md"]);

  const route = run(root, ["decisions.tsv"]);
  assert.equal(route.status, 0, route.stdout);
  assert.equal(route.stdout, "");

  const glob = run(root, ["b[1]/decisions.tsv"]);
  assert.equal(glob.status, 0, glob.stdout);
  assert.equal(glob.stdout, "");
});

test("checks an absolute path only when its first segment exists", (t) => {
  const root = repository(t);
  writeLog(root, ["/api/spike", "/v1/messages", "/assets/x.js", `${root}/gone/x`]);

  const result = run(root, ["decisions.tsv"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, `decisions.tsv:5: ${root}/gone/x (no such file)\n`);
});

test("skips word:N and rev:path tokens whose word is not a file", (t) => {
  const root = repository(t);
  writeLog(root, [
    "exit:1",
    "step:2",
    "PR:40",
    "node:22",
    "localhost:8080",
    "missing-file:12",
    "HEAD:package.json",
    "see:README.md",
  ]);

  const result = run(root, ["decisions.tsv"]);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout, "");
});

test("reads pointers inside quotes, brackets, angle brackets, and Markdown links", (t) => {
  const root = repository(t);
  writeLog(root, [
    "[link](docs/real.md)",
    "docs/real.md'",
    "<docs/real.md>",
    "'docs/missing.md'",
    "[docs/missing.md]",
    "<docs/missing.md>",
    "[some text](docs/gone.md)",
  ]);

  const result = run(root, ["decisions.tsv"]);
  assert.equal(result.status, 1);
  assert.deepEqual(result.stdout.trimEnd().split("\n"), [
    "decisions.tsv:5: docs/missing.md (no such file)",
    "decisions.tsv:6: docs/missing.md (no such file)",
    "decisions.tsv:7: docs/missing.md (no such file)",
    "decisions.tsv:8: docs/gone.md (no such file)",
  ]);
});

test("treats artifact extensions as pointers and leaves web domains alone", (t) => {
  const root = repository(t);
  writeLog(root, [
    "trace.cpuprofile",
    "shot.jpeg",
    "clip.mov",
    "main.c",
    "spec.tla",
    "example.com",
  ]);

  const result = run(root, ["decisions.tsv"]);
  assert.equal(result.status, 1);
  assert.deepEqual(result.stdout.trimEnd().split("\n"), [
    "decisions.tsv:2: trace.cpuprofile (no such file)",
    "decisions.tsv:3: shot.jpeg (no such file)",
    "decisions.tsv:4: clip.mov (no such file)",
    "decisions.tsv:5: main.c (no such file)",
    "decisions.tsv:6: spec.tla (no such file)",
  ]);
});

test("checks a token that ends in a slash as a directory", (t) => {
  const root = repository(t);
  writeLog(root, ["docs/", "baseline/", "README.md/"]);

  const result = run(root, ["decisions.tsv"]);
  assert.equal(result.status, 1);
  assert.deepEqual(result.stdout.trimEnd().split("\n"), [
    "decisions.tsv:3: baseline/ (no such file)",
    "decisions.tsv:4: README.md/ (no such file)",
  ]);
});

test("exits 64 with a message when git cannot list the tracked files", (t) => {
  const root = repository(t);
  writeFileSync(join(root, ".git/index"), "DIRC");
  writeLog(root, ["README.md"]);

  const result = run(root, ["decisions.tsv"]);
  assert.equal(result.status, 64);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^check-evidence\.ts: git ls-files failed in .+\n$/);
});

const runsAsRoot = process.getuid?.() === 0;

test(
  "reports an unreadable file and keeps checking later rows",
  { skip: runsAsRoot && "root reads files whatever their mode" },
  (t) => {
    const root = repository(t);
    writeFileSync(join(root, "secret.md"), "a\n");
    chmodSync(join(root, "secret.md"), 0o000);
    writeLog(root, ["secret.md:1", "docs/missing.md"]);

    const result = run(root, ["decisions.tsv"]);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    assert.deepEqual(result.stdout.trimEnd().split("\n"), [
      "decisions.tsv:2: secret.md:1 (unreadable)",
      "decisions.tsv:3: docs/missing.md (no such file)",
    ]);
  },
);
