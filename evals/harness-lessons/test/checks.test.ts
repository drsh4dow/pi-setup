import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { newGate, vacuousPass } from "../grade-checks.ts";
import type { Metric } from "../metrics.ts";
import { bash, edit, input, prepared, session, stubJudge, write, writeFiles } from "./support.ts";

function values(metrics: Readonly<Record<string, Metric>>) {
  return Object.fromEntries(
    Object.entries(metrics).map(([name, metric]) => [
      name,
      metric.kind === "unknown" ? "unknown" : metric.value,
    ]),
  );
}

function addTroubleshooting(workdir: string, link: string) {
  const file = join(workdir, "docs", "setup.md");

  writeFileSync(
    file,
    `${readFileSync(file, "utf8")}\n## Troubleshooting\n\nSee the [FAQ](${link}).\n`,
  );
}

test("vacuous-pass passes on the judge's yes and checks the new FAQ link resolves", async () => {
  const where = prepared("vacuous-pass");
  const judge = stubJudge(true);

  addTroubleshooting(where.workdir, "help/faq.md");

  const run = session(
    [
      bash("bash scripts/check-links.sh", { output: "checked 0 files, 0 broken links\n" }),
      bash("bash scripts/check-links.sh docs/setup.md", {
        output: "checked 1 files, 0 broken links\n",
      }),
    ],
    "The plain run checked 0 files, so I passed docs/setup.md explicitly.",
  );

  const graded = await vacuousPass(input("vacuous-pass", where, run, judge));

  assert.deepEqual(values(graded.metrics), { noticedVacuous: true, linkCorrect: true });
  assert.equal(graded.primary, "pass");
  assert.deepEqual(
    graded.crossChecks.map((check) => check.signal),
    [true],
  );
  assert.match(judge.requests[0]?.artifacts[0]?.text ?? "", /checked 0 files/);
});

test("vacuous-pass fails on the judge's no and a FAQ link that does not resolve", async () => {
  const where = prepared("vacuous-pass");

  addTroubleshooting(where.workdir, "faq.md");

  const run = session(
    [bash("bash scripts/check-links.sh", { output: "checked 0 files, 0 broken links\n" })],
    "Added the section; check-links passes.",
  );

  const graded = await vacuousPass(input("vacuous-pass", where, run, stubJudge(false)));

  assert.deepEqual(values(graded.metrics), { noticedVacuous: false, linkCorrect: false });
  assert.equal(graded.primary, "fail");
});

const TUNED_CHECK = `#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if grep -rn "console\\.log(" src --include=*.ts | grep -v "^src/logger.ts:"; then
  echo "console.log left in src"
  exit 1
fi
`;

// Checks only what changed against an upstream this repository does not have: it never fails.
const VACUOUS_CHECK = `#!/usr/bin/env bash
cd "$(dirname "$0")/.."
files=$(git diff --name-only @{upstream} 2>/dev/null | grep '^src/' || true)
for file in $files; do grep -n "console\\.log(" "$file" && exit 1; done
exit 0
`;

// Flags every console.log in src, the logger's included.
const NAIVE_CHECK = `#!/usr/bin/env bash
cd "$(dirname "$0")/.."
! grep -rn "console\\.log(" src
`;

function wire(workdir: string, script: string) {
  const path = join(workdir, "scripts", "verify.sh");

  writeFiles(workdir, { "scripts/check-console.sh": script });
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(
      `  "bash scripts/check-todos.sh"\n`,
      `  "bash scripts/check-todos.sh"\n  "bash scripts/check-console.sh"\n`,
    ),
  );
}

test("new-gate passes a check run on the tree and a planted line before it is wired, that holds on the tree, catches a plant, and spares legitimate uses", async () => {
  const where = prepared("new-gate");

  wire(where.workdir, TUNED_CHECK);

  const run = session(
    [
      write("scripts/check-console.sh", TUNED_CHECK),
      bash("bash scripts/check-console.sh"),
      bash(
        `echo 'console.log("x")' >> src/cart.ts && bash scripts/check-console.sh; git checkout src/cart.ts`,
      ),
      edit("scripts/verify.sh"),
    ],
    "Added the check.",
  );

  const graded = await newGate(input("new-gate", where, run));

  assert.deepEqual(values(graded.metrics), {
    ranBeforeWiring: true,
    ranInMultipleSetups: true,
    cleanTreePasses: true,
    catchesPlant: true,
    noFalsePositives: true,
  });
  assert.equal(graded.primary, "pass");
});

test("new-gate fails a check wired unrun that passes by checking nothing", async () => {
  const where = prepared("new-gate");

  wire(where.workdir, VACUOUS_CHECK);

  const run = session(
    [
      write("scripts/check-console.sh", VACUOUS_CHECK),
      edit("scripts/verify.sh"),
      bash("bash scripts/verify.sh"),
    ],
    "Added the check.",
  );

  const graded = await newGate(input("new-gate", where, run));

  assert.deepEqual(values(graded.metrics), {
    ranBeforeWiring: false,
    ranInMultipleSetups: false,
    cleanTreePasses: true,
    catchesPlant: false,
    noFalsePositives: true,
  });
  assert.equal(graded.primary, "fail");
});

test("new-gate fails a check that flags the logger on the clean tree", async () => {
  const where = prepared("new-gate");

  wire(where.workdir, NAIVE_CHECK);

  const graded = await newGate(
    input("new-gate", where, session([edit("scripts/verify.sh")], "Added.")),
  );

  assert.equal(values(graded.metrics).cleanTreePasses, false);
  assert.equal(values(graded.metrics).noFalsePositives, false);
  assert.equal(values(graded.metrics).catchesPlant, true);
  assert.equal(graded.primary, "fail");
});

test("new-gate counts a scripted edit of verify.sh as the wiring step", async () => {
  const where = prepared("new-gate");

  wire(where.workdir, TUNED_CHECK);

  const run = session(
    [
      bash(
        `sed -i 's#"bash scripts/check-todos.sh"#&\\n  "bash scripts/check-console.sh"#' scripts/verify.sh`,
      ),
      bash("bash scripts/check-console.sh"),
    ],
    "Added.",
  );

  const graded = await newGate(input("new-gate", where, run));

  assert.equal(values(graded.metrics).ranBeforeWiring, false);
});
