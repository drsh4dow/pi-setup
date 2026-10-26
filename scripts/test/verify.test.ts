import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  classifyOutcomes,
  detailsMatchRun,
  detailsRead,
  failureReport,
  innerRunArgs,
  parseLastDetails,
  taskLine,
  verifyReport,
} from "../verify.ts";

// Shaped like `vp run --last-details` from Vite+ 1.4.0 after a broken link failed test:docs
// and the task runner killed the two tasks still running.
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
  command: "$ node --test --test-reporter=dot scripts/test/*.test.ts",
};

const babysit = {
  order: 15,
  task: "pi-dotfiles#verify:babysit-scripts",
  command: "~/agent/skills/babysit/scripts$ vp exec bun test --only-failures",
};

const verifyDocs = {
  order: 16,
  task: "pi-dotfiles#test:docs",
  command: "$ node scripts/verify-docs.ts",
};

const testExtensions = {
  order: 17,
  task: "pi-dotfiles#test:extensions",
  command:
    "$ node --test --test-reporter=dot $(find agent/extensions -path '*/test/*.test.ts' ! -name 'e2e.test.ts' -print | sort)",
};

const buildCli = {
  order: 18,
  task: "pi-dotfiles#build:cli",
  command:
    "$ vp exec bun build --compile --outfile .build/bin/pi-subagent agent/extensions/subagents/bin/pi-subagent.ts > /dev/null",
};

// An outcome for the classification cases, whose command does not matter.
function outcome(order: number, task: string, exitCode: number) {
  return { order, task: `pi-dotfiles#${task}`, command: "$ true", exitCode };
}

test("the inner run is the named task, with the options after it passed to the run", () => {
  assert.deepEqual(innerRunArgs(["verify:all-without-video", "--no-cache"]), {
    kind: "run",
    args: ["run", "--log", "labeled", "--no-cache", "verify:all-without-video"],
  });
  assert.deepEqual(innerRunArgs(["verify:all"]), {
    kind: "run",
    args: ["run", "--log", "labeled", "verify:all"],
  });
});

test("a missing task name is a usage error, not a run of the default task", () => {
  assert.equal(innerRunArgs([]).kind, "usage");
  assert.equal(innerRunArgs(["--no-cache"]).kind, "usage");
});

test("reads each command's task and exit code from the last run's details", () => {
  assert.deepEqual(parseLastDetails(brokenLinkDetails), [
    { ...testDocs, exitCode: 0 },
    { ...babysit, exitCode: 0 },
    { ...verifyDocs, exitCode: 1 },
    { ...testExtensions, exitCode: 137 },
    { ...buildCli, exitCode: 137 },
  ]);
});

test("the tasks killed after the first failure are stopped, not failed", () => {
  assert.deepEqual(classifyOutcomes(parseLastDetails(brokenLinkDetails)), {
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
  const result = classifyOutcomes(parseLastDetails(brokenLinkDetails));
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

// The commands the broken-link details list, as the run printed them when each started.
const brokenLinkRun = {
  linesByTask: new Map([
    [
      "pi-dotfiles#test:docs",
      [`${testDocs.command} ⊘ cache disabled`, "....", `${verifyDocs.command} ⊘ cache disabled`],
    ],
    ["pi-dotfiles#verify:babysit-scripts", [`${babysit.command} ⊘ cache disabled`, "1 pass"]],
    ["pi-dotfiles#test:extensions", [`${testExtensions.command} ⊘ cache disabled`]],
    ["pi-dotfiles#build:cli", [`${buildCli.command} ⊘ cache disabled`]],
  ]),
  commandCount: 5,
};

test("details whose every command this run started, as many as it counted, are this run's", () => {
  assert.equal(detailsMatchRun(parseLastDetails(brokenLinkDetails), brokenLinkRun), true);
});

test("details with a command this run did not start, or a different count, are another run's", () => {
  const outcomes = parseLastDetails(brokenLinkDetails);
  const withoutBuild = new Map(brokenLinkRun.linesByTask);
  withoutBuild.set("pi-dotfiles#build:cli", ["$ vp exec bun build --other ⊘ cache disabled"]);

  assert.equal(detailsMatchRun(outcomes, { ...brokenLinkRun, linesByTask: withoutBuild }), false);
  assert.equal(detailsMatchRun(outcomes, { ...brokenLinkRun, commandCount: 6 }), false);
});

test("a details read that fails is reported with its reason and stderr", () => {
  const read = detailsRead({
    error: undefined,
    signal: null,
    status: 2,
    stdout: "",
    stderr: "vp: cannot read execution details\n",
  });

  assert.deepEqual(verifyReport(1, read, brokenLinkRun), [
    "verify: failed (exit 1), but `vp run --last-details` exited 2 and listed no command, so it cannot name the failed task. Read the task output above.",
    "vp: cannot read execution details",
  ]);
});

test("details of this run that list no failed command say so instead of naming one", () => {
  const passing = brokenLinkDetails.replaceAll(/✗ \(exit code: \d+\)/gu, "✓");

  const read = detailsRead({
    error: undefined,
    signal: null,
    status: 0,
    stdout: passing,
    stderr: "",
  });

  assert.deepEqual(verifyReport(1, read, brokenLinkRun), [
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
    decoy: { command: node("process.exit(9)"), cache: false },
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

// A `vp` first on PATH that runs the given shell code before `vp run --last-details`, then the
// real vp, so a test can make the details read fail or let another run replace the details.
function beforeLastDetails(root: string, shell: string) {
  const vp = execFileSync("sh", ["-c", "command -v vp"], { encoding: "utf8" }).trim();
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "vp"),
    `#!/bin/sh\nif [ "$1 $2" = "run --last-details" ]; then\n${shell}\nfi\nexec "${vp}" "$@"\n`,
  );
  chmodSync(join(bin, "vp"), 0o755);

  return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, REAL_VP: vp };
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

test("details another run replaced are not read as this run's failure", (t) => {
  const root = taskGraph(t);

  const result = verify(
    root,
    "failing",
    beforeLastDetails(root, '"$REAL_VP" run decoy >/dev/null 2>&1'),
  );

  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(result.report, [
    "verify: failed (exit 1), but the last run details list commands this run did not run, so another vp run in this workspace replaced them. Read the task output above.",
  ]);
});

test("a details read that fails keeps the run's exit status and shows the read's error", (t) => {
  const root = taskGraph(t);

  const result = verify(
    root,
    "failing",
    beforeLastDetails(root, 'echo "vp: cannot read execution details" >&2; exit 2'),
  );

  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(result.report, [
    "verify: failed (exit 1), but `vp run --last-details` exited 2 and listed no command, so it cannot name the failed task. Read the task output above.",
    "vp: cannot read execution details",
  ]);
});
