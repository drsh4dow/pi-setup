import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { stripVTControlCharacters } from "node:util";

import {
  classifyOutcomes,
  failureReport,
  innerRunArgs,
  parseDetails,
  taskLine,
  verifyReport,
} from "../verify.ts";

// Shaped like the details `vp run -v` ends with, from Vite+ 1.4.0, after a broken link failed
// test:docs and the task runner killed the two tasks still running.
const brokenLinkDetails = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    Vite+ Task Runner • Execution Summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Statistics:   17 tasks • 0 cache hits • 0 cache misses • 17 cache disabled
Performance:  0% cache hit rate

Task Details:
────────────────────────────────────────────────
  [14] pi-dotfiles#test:docs: $ node --test --test-reporter=dot scripts/test/*.test.ts ✓
      → Cache disabled in task configuration
  ·······················································
  [15] pi-dotfiles#verify:babysit-scripts: ~/agent/skills/babysit/scripts$ vp exec bun test --only-failures ✓
      → Cache disabled in task configuration
  ·······················································
  [16] pi-dotfiles#test:docs: $ node scripts/verify-docs.ts ✗ (exit code: 1)
      → Cache disabled in task configuration
  ·······················································
  [17] pi-dotfiles#test:extensions: $ node --test --test-reporter=dot $(find agent/extensions -path '*/test/*.test.ts' ! -name 'e2e.test.ts' -print | sort) ✗ (exit code: 137)
      → Cache disabled in task configuration
  ·······················································
  [18] pi-dotfiles#build:cli: $ vp exec bun build --compile --outfile .build/bin/pi-subagent agent/extensions/subagents/bin/pi-subagent.ts > /dev/null ✗ (exit code: 137)
      → Cache disabled in task configuration
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

const testDocs = {
  order: 14,
  task: "pi-dotfiles#test:docs",
};

const babysit = {
  order: 15,
  task: "pi-dotfiles#verify:babysit-scripts",
};

const verifyDocs = {
  order: 16,
  task: "pi-dotfiles#test:docs",
};

const testExtensions = {
  order: 17,
  task: "pi-dotfiles#test:extensions",
};

const buildCli = {
  order: 18,
  task: "pi-dotfiles#build:cli",
};

function outcome(order: number, task: string, exitCode: number) {
  return { order, task: `pi-dotfiles#${task}`, exitCode };
}

test("the inner run is the named task, with the options after it passed to the run", () => {
  assert.deepEqual(innerRunArgs(["verify:all-without-video", "--no-cache"]), {
    kind: "run",
    args: ["run", "--log", "labeled", "-v", "--no-cache", "verify:all-without-video"],
  });
  assert.deepEqual(innerRunArgs(["verify:all"]), {
    kind: "run",
    args: ["run", "--log", "labeled", "-v", "verify:all"],
  });
});

test("a missing task name is a usage error, not a run of the default task", () => {
  assert.equal(innerRunArgs([]).kind, "usage");
  assert.equal(innerRunArgs(["--no-cache"]).kind, "usage");
});

test("reads each command's task and exit code from the run's details", () => {
  assert.deepEqual(parseDetails(brokenLinkDetails), [
    { ...testDocs, exitCode: 0 },
    { ...babysit, exitCode: 0 },
    { ...verifyDocs, exitCode: 1 },
    { ...testExtensions, exitCode: 137 },
    { ...buildCli, exitCode: 137 },
  ]);
});

test("the tasks killed after the first failure are stopped, not failed", () => {
  assert.deepEqual(classifyOutcomes(parseDetails(brokenLinkDetails)), {
    kind: "failed",
    failed: [{ ...verifyDocs, exitCode: 1 }],
    stopped: [
      { ...testExtensions, exitCode: 137 },
      { ...buildCli, exitCode: 137 },
    ],
  });
});

test("a 137 that comes before any other failure is a failure", () => {
  const result = classifyOutcomes([
    outcome(4, "test:docs", 137),
    outcome(2, "test:evals", 0),
    outcome(5, "test:extensions", 137),
  ]);

  assert.deepEqual(result, {
    kind: "failed",
    failed: [outcome(4, "test:docs", 137)],
    stopped: [outcome(5, "test:extensions", 137)],
  });
});

test("a later failure with its own exit code is a failure too", () => {
  const result = classifyOutcomes([
    outcome(1, "test:docs", 1),
    outcome(2, "test:extensions", 137),
    outcome(3, "verify:skills", 2),
  ]);

  assert.deepEqual(result, {
    kind: "failed",
    failed: [outcome(1, "test:docs", 1), outcome(3, "verify:skills", 2)],
    stopped: [outcome(2, "test:extensions", 137)],
  });
});

test("the order the commands finished in decides the first failure, not the order listed", () => {
  const result = classifyOutcomes([
    outcome(4, "test:extensions", 137),
    outcome(3, "verify:skills", 2),
    outcome(2, "test:evals", 0),
    outcome(1, "test:docs", 137),
  ]);

  assert.deepEqual(result, {
    kind: "failed",
    failed: [outcome(1, "test:docs", 137), outcome(3, "verify:skills", 2)],
    stopped: [outcome(4, "test:extensions", 137)],
  });
});

test("a run with no failed command passed", () => {
  assert.deepEqual(classifyOutcomes([outcome(1, "test:docs", 0), outcome(2, "verify", 0)]), {
    kind: "passed",
  });
});

test("a labeled line splits into its task and the text the task printed", () => {
  assert.deepEqual(taskLine("[pi-dotfiles#test:docs] docs/a.md: broken local link b.md"), {
    task: "pi-dotfiles#test:docs",
    text: "docs/a.md: broken local link b.md",
  });
  assert.deepEqual(taskLine("\u001B[2m[pi-dotfiles#test:docs]\u001B[0m $ node x.ts"), {
    task: "pi-dotfiles#test:docs",
    text: "$ node x.ts",
  });
  assert.deepEqual(taskLine("vp run: 0/17 cache hit (0%), 3 failed."), {
    task: null,
    text: "vp run: 0/17 cache hit (0%), 3 failed.",
  });
});

test("the report names the failed task with its own output, then the stopped tasks", () => {
  const result = classifyOutcomes(parseDetails(brokenLinkDetails));
  assert.equal(result.kind, "failed");

  const output = new Map([
    [
      "pi-dotfiles#test:docs",
      [
        "$ node --test --test-reporter=dot scripts/test/*.test.ts ⊘ cache disabled",
        "....",
        "$ node scripts/verify-docs.ts ⊘ cache disabled",
        "docs/development.md: broken local link docs/missing.md",
      ],
    ],
    ["pi-dotfiles#test:extensions", ["...."]],
  ]);

  assert.deepEqual(failureReport(result, output), [
    "verify: test:docs failed (exit 1)",
    "$ node --test --test-reporter=dot scripts/test/*.test.ts ⊘ cache disabled",
    "....",
    "$ node scripts/verify-docs.ts ⊘ cache disabled",
    "docs/development.md: broken local link docs/missing.md",
    "verify: stopped after the failure: test:extensions, build:cli",
  ]);
});

test("the report says when a failed task printed nothing and when nothing was stopped", () => {
  const result = classifyOutcomes([outcome(3, "test:evals", 137)]);
  assert.equal(result.kind, "failed");

  assert.deepEqual(failureReport(result, new Map()), [
    "verify: test:evals failed (exit 137)",
    "verify: test:evals printed nothing",
  ]);
});

test("details of this run that list no failed command say so instead of naming one", () => {
  const passing = brokenLinkDetails.replaceAll(/✗ \(exit code: \d+\)/gu, "✓");

  assert.deepEqual(verifyReport(1, parseDetails(passing), new Map()), [
    "verify: failed (exit 1), but its run details list no failed command. Read the task output above.",
  ]);
});

const verifyScript = new URL("../verify.ts", import.meta.url).pathname;

function node(code: string) {
  return `node -e '${code}'`;
}

// A Vite+ project with a failing graph, where bad fails while slow still runs, and a passing one.
function taskGraph(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "verify-graph-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const tasks = {
    slow: { command: node("setTimeout(() => {}, 30000)"), cache: false },
    bad: {
      command: node(
        'setTimeout(() => { console.error("EXPECTED_FAILURE"); process.exit(7); }, 500)',
      ),
      cache: false,
    },
    "shared-slow": {
      command: node(
        'if (process.env.RUN_KIND === "other") setTimeout(() => process.exit(9), 200); else setTimeout(() => {}, 30000)',
      ),
      cache: false,
    },
    "shared-bad": {
      command: node(
        'if (process.env.RUN_KIND === "other") process.exit(0); setTimeout(() => { console.error("OWN_FAILURE"); process.exit(7); }, 500)',
      ),
      cache: false,
    },
    shared: { command: "echo done", dependsOn: ["shared-slow", "shared-bad"], cache: false },
    good: { command: "echo good-out", cache: false },
    failing: { command: "echo done", dependsOn: ["slow", "bad"], cache: false },
    passing: { command: "echo done", dependsOn: ["good"], cache: false },
  };

  writeFileSync(join(root, "package.json"), '{ "name": "graph", "type": "module" }\n');
  writeFileSync(
    join(root, "vite.config.ts"),
    `export default ${JSON.stringify({ run: { tasks } }, null, 2)};\n`,
  );
  execFileSync("git", ["init", "--quiet"], { cwd: root });

  return root;
}

// Puts a `vp` first on PATH whose script runs with $VP set to the real vp.
function vpShim(root: string, script: string) {
  const vp = execFileSync("sh", ["-c", "command -v vp"], { encoding: "utf8" }).trim();
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "vp"), `#!/bin/sh\nVP="${vp}"\n${script}\n`);
  chmodSync(join(bin, "vp"), 0o755);

  return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, REAL_VP: vp };
}

// Runs the given shell code after each `vp run` ends, so another run can end after verify's
// inner run and before verify reports.
function afterEachRun(root: string, shell: string) {
  return vpShim(root, `"$VP" "$@"\nstatus=$?\n${shell}\nexit $status`);
}

function verify(root: string, task: string, env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(process.execPath, [verifyScript, task], {
    cwd: root,
    encoding: "utf8",
    env,
  });

  const stdout = result.stdout.trimEnd().split("\n");

  return { ...result, stdout, report: stdout.slice(stdout.lastIndexOf("") + 1) };
}

test("a failing run exits 1 and ends with the failed task, its output, and the stopped task", (t) => {
  const result = verify(taskGraph(t), "failing");

  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(result.report, [
    "verify: bad failed (exit 7)",
    `$ node -e 'setTimeout(() => { console.error("EXPECTED_FAILURE"); process.exit(7); }, 500)' ⊘ cache disabled`,
    "EXPECTED_FAILURE",
    "verify: stopped after the failure: slow",
  ]);
});

test("a passing run exits 0 and prints no report", (t) => {
  const result = verify(taskGraph(t), "passing");

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("good-out"), result.stdout.join("\n"));
  assert.deepEqual(
    result.stdout.filter((line) => line.startsWith("verify:")),
    [],
  );
});

test("a passing run prints as many lines as the task runner prints without verify", (t) => {
  const root = taskGraph(t);

  const result = verify(root, "passing");

  const quiet = spawnSync("vp", ["run", "--log", "labeled", "passing"], {
    cwd: root,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(
    result.stdout.length,
    quiet.stdout.trimEnd().split("\n").length,
    result.stdout.join("\n"),
  );
});

test("another run of the same graph ending first does not change which task verify names", (t) => {
  const root = taskGraph(t);

  const result = verify(
    root,
    "shared",
    afterEachRun(root, 'RUN_KIND=other "$REAL_VP" run --no-cache shared >/dev/null 2>&1'),
  );

  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(result.report, [
    "verify: shared-bad failed (exit 7)",
    `$ node -e 'if (process.env.RUN_KIND === "other") process.exit(0); setTimeout(() => { console.error("OWN_FAILURE"); process.exit(7); }, 500)' ⊘ cache disabled`,
    "OWN_FAILURE",
    "verify: stopped after the failure: shared-slow",
  ]);
});

test("a failed run that prints no details says verify cannot tell which task failed", (t) => {
  const root = taskGraph(t);

  const result = verify(
    root,
    "failing",
    vpShim(
      root,
      `{ "$VP" "$@" 2>&1; echo $? >"${root}/status"; } | grep -v '━'\nexit $(cat "${root}/status")`,
    ),
  );

  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(result.report, [
    "verify: failed (exit 1), but the run printed no details, so verify cannot tell which task failed. Read the output above.",
  ]);
});

test("a rule of ━ that task output follows is relayed, not read as the run's details", (t) => {
  const root = taskGraph(t);

  const result = verify(
    root,
    "failing",
    vpShim(root, `echo ━━━━━━━━\necho EARLY_NOTE\nexec "$VP" "$@"`),
  );

  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stdout.includes("EARLY_NOTE"), result.stdout.join("\n"));
  assert.deepEqual(result.report, [
    "verify: bad failed (exit 7)",
    `$ node -e 'setTimeout(() => { console.error("EXPECTED_FAILURE"); process.exit(7); }, 500)' ⊘ cache disabled`,
    "EXPECTED_FAILURE",
    "verify: stopped after the failure: slow",
  ]);
});

test("a startup failure after a rule of ━ keeps what the task runner printed", (t) => {
  const root = mkdtempSync(join(tmpdir(), "verify-startup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), '{ "name": "graph", "type": "module" }\n');
  writeFileSync(join(root, "vite.config.ts"), "export default { run: ;\n");
  execFileSync("git", ["init", "--quiet"], { cwd: root });

  const env = vpShim(root, `echo ━━━━━━━━ >&2\necho EARLY_DIAGNOSTIC >&2\nexec "$VP" "$@"`);
  const result = verify(root, "failing", env);

  const direct = spawnSync(env.REAL_VP ?? "vp", ["run", "--log", "labeled", "-v", "failing"], {
    cwd: root,
    encoding: "utf8",
  });

  assert.equal(result.status, 1, result.stderr);
  assert.notEqual(direct.status, 0, direct.stderr);
  assert.match(direct.stderr, /PARSE_ERROR/u);
  assert.equal(
    result.stderr,
    `━━━━━━━━\nEARLY_DIAGNOSTIC\n${stripVTControlCharacters(direct.stderr)}`,
  );
  assert.deepEqual(result.report, [
    "verify: failed (exit 1), but the run printed no details, so verify cannot tell which task failed. Read the output above.",
  ]);
});
