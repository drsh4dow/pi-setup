import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyOutcomes,
  failureReport,
  innerRunArgs,
  parseLastDetails,
  taskLine,
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

test("the inner run is the named task, with the options after it passed to the run", () => {
  assert.deepEqual(innerRunArgs(["verify:checks", "--no-cache"]), {
    kind: "run",
    args: ["run", "--log", "labeled", "--no-cache", "verify:checks"],
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
    { order: 14, task: "pi-dotfiles#test:docs", exitCode: 0 },
    { order: 15, task: "pi-dotfiles#verify:babysit-scripts", exitCode: 0 },
    { order: 16, task: "pi-dotfiles#test:docs", exitCode: 1 },
    { order: 17, task: "pi-dotfiles#test:extensions", exitCode: 137 },
    { order: 18, task: "pi-dotfiles#build:cli", exitCode: 137 },
  ]);
});

test("the tasks killed after the first failure are stopped, not failed", () => {
  assert.deepEqual(classifyOutcomes(parseLastDetails(brokenLinkDetails)), {
    kind: "failed",
    failed: [{ order: 16, task: "pi-dotfiles#test:docs", exitCode: 1 }],
    stopped: [
      { order: 17, task: "pi-dotfiles#test:extensions", exitCode: 137 },
      { order: 18, task: "pi-dotfiles#build:cli", exitCode: 137 },
    ],
  });
});

test("a 137 that comes before any other failure is a failure", () => {
  const result = classifyOutcomes([
    { order: 4, task: "pi-dotfiles#test:docs", exitCode: 137 },
    { order: 2, task: "pi-dotfiles#test:evals", exitCode: 0 },
    { order: 5, task: "pi-dotfiles#test:extensions", exitCode: 137 },
  ]);

  assert.deepEqual(result, {
    kind: "failed",
    failed: [{ order: 4, task: "pi-dotfiles#test:docs", exitCode: 137 }],
    stopped: [{ order: 5, task: "pi-dotfiles#test:extensions", exitCode: 137 }],
  });
});

test("a later failure with its own exit code is a failure too", () => {
  const result = classifyOutcomes([
    { order: 1, task: "pi-dotfiles#test:docs", exitCode: 1 },
    { order: 2, task: "pi-dotfiles#test:extensions", exitCode: 137 },
    { order: 3, task: "pi-dotfiles#verify:skills", exitCode: 2 },
  ]);

  assert.deepEqual(result, {
    kind: "failed",
    failed: [
      { order: 1, task: "pi-dotfiles#test:docs", exitCode: 1 },
      { order: 3, task: "pi-dotfiles#verify:skills", exitCode: 2 },
    ],
    stopped: [{ order: 2, task: "pi-dotfiles#test:extensions", exitCode: 137 }],
  });
});

test("a run with no failed command passed", () => {
  assert.deepEqual(
    classifyOutcomes([
      { order: 1, task: "pi-dotfiles#test:docs", exitCode: 0 },
      { order: 2, task: "pi-dotfiles#verify", exitCode: 0 },
    ]),
    { kind: "passed" },
  );
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
  const result = classifyOutcomes([{ order: 3, task: "pi-dotfiles#test:evals", exitCode: 137 }]);
  assert.equal(result.kind, "failed");

  assert.deepEqual(failureReport(result, new Map()), [
    "verify: test:evals failed (exit 137)",
    "verify: test:evals printed nothing",
  ]);
});
