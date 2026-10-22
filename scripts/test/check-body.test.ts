import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

const checker = new URL(
  "../../agent/skills/writing-good-prs/scripts/check-body.ts",
  import.meta.url,
).pathname;

const issueTemplate = new URL("../../.github/ISSUE_TEMPLATE/ticket.md", import.meta.url).pathname;

function check(t: TestContext, body: string, args: string[]) {
  const root = mkdtempSync(join(tmpdir(), "check-body-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "body.md");
  writeFileSync(file, body);
  const result = spawnSync(checker, [args[0], file, ...args.slice(1)], { encoding: "utf8" });

  return {
    status: result.status,
    lines: result.stdout.replaceAll(`${file}:`, "").split("\n").filter(Boolean),
  };
}

const goodPr = `## Why

Agents wrote PR bodies in three shapes. Closes #47.

## Shape

\`\`\`diff
 agent/skills/
+├── writing-good-prs/
## this line is inside a fence, not a heading
\`\`\`

## Evidence

- \`node --test scripts/test/check-body.test.ts\` fails on the base and passes on the head.

## Merge danger

Two-way door. Blast radius: agents that write PR bodies.

## Scope

- Leaves the babysit playbook alone.
`;

test("passes a PR body in the default shape, ignoring headings inside fenced blocks", (t) => {
  const result = check(t, goodPr, ["pr", "--title", "feat(skills): add writing-good-prs"]);

  assert.deepEqual(result.lines, []);
  assert.equal(result.status, 0);
});

test("flags Evidence that names no artifact and Merge danger that names no door", (t) => {
  const body = goodPr
    .replace(/- `node --test.*\n/, "Tests pass.\n")
    .replace("Two-way door. Blast radius: agents that write PR bodies.", "Low risk.");

  const result = check(t, body, ["pr"]);

  assert.equal(result.status, 1);
  assert.deepEqual(result.lines, [
    '13: "## Evidence" names no artifact, add the test, command, output, or media link that shows before and after',
    '17: "## Merge danger" does not say "one-way door" or "two-way door"',
    '17: "## Merge danger" does not name the blast radius',
  ]);
});

test("takes the shape from the issue template, and flags the template left unfilled", (t) => {
  const filled = `## Problem

\`pi-subagent\` leaks a background job after SIGHUP.

## Done when

- [ ] A \`bg_start\` job that traps SIGTERM exits with its subagent.

## Out of scope

- Volta shims.
`;

  const filledResult = check(t, filled, ["ticket", "--template", issueTemplate]);

  assert.deepEqual(filledResult.lines, []);

  const unfilled = readFileSync(issueTemplate, "utf8");
  const unfilledResult = check(t, unfilled, ["ticket", "--template", issueTemplate]);

  assert.equal(unfilledResult.status, 1);
  assert.ok(
    unfilledResult.lines.some((line) =>
      line.endsWith("template comment left in, replace or delete it"),
    ),
    unfilledResult.lines.join("\n"),
  );
});
