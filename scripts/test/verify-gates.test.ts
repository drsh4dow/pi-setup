import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

const script = new URL("../verify-gates.ts", import.meta.url).pathname;

// Written in pieces so this file does not itself add the moves the guard looks for.
const SKIP = ["it", "skip"].join(".");

const TS_IGNORE = ["// @ts", "ignore"].join("-");

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

const baseline = {
  "src/sum.js": "export function sum(a, b) {\n  return a + b;\n}\n",
  "test/sum.test.js": [
    'import assert from "node:assert/strict";',
    'import { it } from "node:test";',
    'import { sum } from "../src/sum.js";',
    "",
    'it("adds", () => {',
    "  assert.equal(sum(1, 2), 3);",
    "  assert.equal(sum(-1, 1), 0);",
    "});",
    "",
  ].join("\n"),
  "lint.config.js": [
    "export default {",
    "  maxWarnings: 5,",
    "  threshold: 0.8,",
    '  rules: { "no-console": "error" },',
    "};",
    "",
  ].join("\n"),
  "package.json": '{\n  "scripts": {\n    "verify": "node lint.js && node --test"\n  }\n}\n',
  ".github/workflows/ci.yml":
    "jobs:\n  verify:\n    # lint and test every push\n    run: npm run verify\n",
} satisfies Readonly<Record<string, string>>;

function repo(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "verify-gates-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const work = join(dir, "work");
  const origin = join(dir, "origin.git");

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: work, env, encoding: "utf8" });

  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), content);
  };

  const replace = (path: string, from: string, to: string) => {
    const content = readFileSync(join(work, path), "utf8");

    assert.ok(content.includes(from), `${path} has no ${from}`);
    write(path, content.replace(from, to));
  };

  mkdirSync(work);
  git("init", "-q", "-b", "main");

  for (const [path, content] of Object.entries(baseline)) write(path, content);

  git("add", "-A");
  git("commit", "-qm", "baseline");
  execFileSync("git", ["clone", "-q", "--bare", work, origin], { env });
  git("remote", "add", "origin", origin);
  git("fetch", "-q", "origin");
  git("branch", "-q", "-u", "origin/main");

  return {
    work,
    write,
    replace,
    git,
    remove: (path: string) => git("rm", "-q", path),
    commit: () => git("commit", "-qam", "change"),
    check: () => {
      const result = spawnSync("node", [script], { cwd: work, env, encoding: "utf8" });

      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    },
  };
}

type Repo = ReturnType<typeof repo>;

const weakenings: readonly { name: string; finding: string; weaken: (r: Repo) => void }[] = [
  {
    name: "a skipped test",
    finding: "test/sum.test.js:5: test-skipped:",
    weaken: (r) => r.replace("test/sum.test.js", 'it("adds"', `${SKIP}("adds"`),
  },
  {
    name: "a deleted test file",
    finding: "test/sum.test.js: test-deleted:",
    weaken: (r) => r.remove("test/sum.test.js"),
  },
  {
    name: "an assertion pulled out of a test that stays",
    finding: "test/sum.test.js: assertions-removed:",
    weaken: (r) => r.replace("test/sum.test.js", "  assert.equal(sum(-1, 1), 0);\n", ""),
  },
  {
    name: "a silenced type checker",
    finding: "src/sum.js:2: checker-silenced:",
    weaken: (r) => r.replace("src/sum.js", "  return", `  ${TS_IGNORE}\n  return`),
  },
  {
    name: "an empty catch spanning lines",
    finding: "src/sum.js:4: empty-catch:",
    weaken: (r) =>
      r.replace(
        "src/sum.js",
        "  return a + b;",
        ["  try {", "    log(a);", "  } catch {", "  }", "  return a + b;"].join("\n"),
      ),
  },
  {
    name: "a raised maximum",
    finding: "lint.config.js:2: threshold-loosened: maxWarnings: 5 -> 9",
    weaken: (r) => r.replace("lint.config.js", "maxWarnings: 5", "maxWarnings: 9"),
  },
  {
    name: "a lowered severity",
    finding: "lint.config.js:4: threshold-loosened: no-console: error -> warn",
    weaken: (r) => r.replace("lint.config.js", '"no-console": "error"', '"no-console": "warn"'),
  },
  {
    name: "a threshold it cannot classify",
    finding: "lint.config.js:3: threshold-changed: threshold: 0.8 -> 0.7",
    weaken: (r) => r.replace("lint.config.js", "threshold: 0.8", "threshold: 0.7"),
  },
  {
    name: "a check dropped from the verify script",
    finding: "package.json:3: check-removed:",
    weaken: (r) => r.replace("package.json", "node lint.js && node --test", "node --test"),
  },
];

for (const { name, finding, weaken } of weakenings) {
  test(`fails on ${name}`, (t) => {
    const r = repo(t);
    weaken(r);

    const result = r.check();

    assert.equal(result.status, 1, result.stdout);
    assert.ok(result.stderr.includes(finding), result.stderr);
  });
}

test("passes a change that leaves every gate as strong as it was", (t) => {
  const r = repo(t);
  r.replace("src/sum.js", "return a + b;", "return b + a;");
  r.replace("lint.config.js", "maxWarnings: 5", "maxWarnings: 0");
  r.replace("lint.config.js", '"no-console": "error"', '"no-console": "deny"');

  const result = r.check();

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Gates verified/);
});

test("covers committed but unpushed changes and untracked files", (t) => {
  const r = repo(t);
  r.replace("test/sum.test.js", 'it("adds"', `${SKIP}("adds"`);
  r.commit();
  r.write("src/new.ts", `${TS_IGNORE}\nexport const x: number = "y";\n`);

  const result = r.check();

  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes("test/sum.test.js:5: test-skipped:"), result.stderr);
  assert.ok(result.stderr.includes("src/new.ts:1: checker-silenced:"), result.stderr);
});

test("with no upstream, checks committed work against the default branch", (t) => {
  const r = repo(t);
  r.git("checkout", "-q", "-b", "feature");
  r.replace("test/sum.test.js", 'it("adds"', `${SKIP}("adds"`);
  r.commit();

  const result = r.check();

  assert.equal(result.status, 1, result.stdout);
  assert.ok(result.stderr.includes("test/sum.test.js:5: test-skipped:"), result.stderr);
  assert.match(result.stderr, /merge base with origin\/(?:HEAD|main)\./);
});

test("a reworded comment in a check config is not a removed check", (t) => {
  const r = repo(t);
  r.replace(".github/workflows/ci.yml", "# lint and test every push", "# verify each push");

  const result = r.check();

  assert.equal(result.status, 0, result.stderr);
});

test("eval fixtures, which verify never runs, gate nothing", (t) => {
  const r = repo(t);
  r.write("evals/review/fixtures/app/test_app.py", "try:\n    go()\nexcept OSError: pass\n");
  r.write("evals/review/changes/app/src/app.ts", `${TS_IGNORE}\nexport const x = 1;\n`);

  const result = r.check();

  assert.equal(result.status, 0, result.stderr);
});

function except(r: Repo, until: string) {
  r.write(
    "scripts/verify-gates.exceptions.json",
    JSON.stringify([
      { path: "test/**", rule: "test-deleted", reason: "suite moved", owner: "t", until },
    ]),
  );
}

test("passes a finding that a current exception covers", (t) => {
  const r = repo(t);
  r.remove("test/sum.test.js");
  except(r, "2999-01-01");

  const result = r.check();

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 findings covered by exceptions/);
});

test("fails when the exception covering a finding has expired", (t) => {
  const r = repo(t);
  r.remove("test/sum.test.js");
  except(r, "2000-01-01");

  const result = r.check();

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /test-deleted exception for test\/\*\* \(owner t\) expired on 2000-01-01/,
  );
});

test("exits 2 when the exceptions file is malformed", (t) => {
  const r = repo(t);
  r.write("scripts/verify-gates.exceptions.json", '[{ "path": "x" }]');

  const result = r.check();

  assert.equal(result.status, 2);
  assert.match(result.stderr, /could not run/);
});

test("exits 2 outside a git repository", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "verify-gates-nogit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const result = spawnSync("node", [script], {
    cwd: dir,
    env: { ...env, GIT_CEILING_DIRECTORIES: dirname(dir) },
    encoding: "utf8",
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /not inside a git repository/);
});
