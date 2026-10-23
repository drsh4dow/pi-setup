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

A reviewer cannot tell whether a PR's proof ran. Closes #47.

## Shape

\`\`\`diff
 agent/skills/
+├── writing-good-prs/
## this line is inside a fence, not a heading
\`\`\`

## Evidence

- **The check flags a body with no witness.** \`node --test scripts/test/check-body.test.ts\`:
  \`\`\`text
  before  ✖ flags Evidence that only names a command
  after   ✔ flags Evidence that only names a command
  \`\`\`

**Not checked:** nothing

## Risk

- **Blast radius.** Agents that write PR bodies with this skill.
- **Door.** Two-way, because the skill and its check are text files.
- **Merge condition.** none
`;

test("passes a PR body in the default shape, ignoring headings inside fenced blocks", (t) => {
  const result = check(t, goodPr, ["pr", "--title", "feat(skills): add writing-good-prs"]);

  assert.deepEqual(result.lines, []);
  assert.equal(result.status, 0);
});

test("flags Evidence that only names a command, and Risk without its labeled lines", (t) => {
  const body = goodPr
    .replace(
      /- \*\*The check flags[\s\S]*?```\n\n\*\*Not checked:\*\* nothing\n/,
      "- `vp run verify` passes.\n",
    )
    .replace(/- \*\*Door\.\*\*.*\n/, "- **Door.** Cheap to revert.\n")
    .replace(/- \*\*Merge condition\.\*\*.*\n/, "");

  const result = check(t, body, ["pr"]);

  assert.equal(result.status, 1);
  assert.deepEqual(result.lines, [
    '13: "## Evidence" shows no witness, paste the output, or add the table, media, or CI link that shows before and after',
    '13: "## Evidence" has no "**Not checked:**" line, list what has no witness or write nothing',
    '17: "## Risk" has no "- **Merge condition.**" line',
    '17: "## Risk" Door line does not say one-way or two-way',
  ]);
});

test("reads a pasted body with its own fences as one block, not as sections", (t) => {
  const pasted = [
    "<details><summary>The ticket body</summary>",
    "",
    "````markdown",
    "## Problem",
    "",
    "```markdown",
    "## Done when",
    "```",
    "````",
    "",
    "</details>",
    "",
  ].join("\n");

  const body = goodPr.replace("**Not checked:** nothing", `${pasted}\n**Not checked:** nothing`);

  const result = check(t, body, ["pr", "--title", "feat(skills): add writing-good-prs"]);

  assert.deepEqual(result.lines, []);
});

test("takes the shape from the issue template, and flags the template left unfilled", (t) => {
  const filled = `Blocked by: #41

## Problem

\`pi-subagent\` leaks a background job after SIGHUP.

## Done when

- [ ] **The job ends with its subagent.** Check: a \`bg_start\` job that traps SIGTERM exits with it.

## Context

- The Volta shim docs, because a shim forks the Pi it starts.
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

test("flags a ticket that keeps the retired Decisions and Out of scope sections", (t) => {
  const body = `## Problem

A stale citation goes unreported without Java.

## Done when

- [ ] **The stale citation is reported.** Check: the check prints it and exits 1.

## Decisions

- Assumed: one fix covers both checks.

## Out of scope

- A citations mode.
`;

  const result = check(t, body, ["ticket", "--title", "verify: a stale citation goes unreported"]);

  assert.equal(result.status, 1);
  assert.deepEqual(result.lines, [
    '9: unexpected heading "## Decisions", use these in order: ## Problem, ## Done when, ## Suggested approach, ## Context',
    '13: unexpected heading "## Out of scope", use these in order: ## Problem, ## Done when, ## Suggested approach, ## Context',
  ]);
});
