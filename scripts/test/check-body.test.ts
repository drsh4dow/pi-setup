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

// The body and the 94-character title from the ticket that added the title cap.
const noCiBody = `## Why

Agents that check a PR in a repository with no CI wait twelve minutes for a status table.

## Evidence

\`\`\`text
$ watch-pr --status-only
exit 0
\`\`\`

**Not checked:** nothing.

## Risk

- **Blast radius.** The status command only.
- **Door.** Two-way, a revert undoes it.
- **Merge condition.** None.
`;

test("caps a PR title at 72 characters, the commit subject limit", (t) => {
  const long =
    "fix(babysit): watch-pr status-only exits at once with a no-checks row on repos that have no CI";

  const longResult = check(t, noCiBody, ["pr", "--title", long]);

  assert.equal(longResult.status, 1);
  assert.deepEqual(longResult.lines, ["title: title is 94 characters, cut it to 72 or fewer"]);

  const oneOver = "fix(babysit): print a no-checks row at once for repos that lack CI checks";
  const oneOverResult = check(t, noCiBody, ["pr", "--title", oneOver]);

  assert.equal(oneOverResult.status, 1);
  assert.deepEqual(oneOverResult.lines, ["title: title is 73 characters, cut it to 72 or fewer"]);

  const fits = "fix(babysit): print a no-checks row at once on repos that lack CI checks";
  const fitsResult = check(t, noCiBody, ["pr", "--title", fits]);

  assert.deepEqual(fitsResult.lines, []);
  assert.equal(fitsResult.status, 0);
});

test("reports a long title beside its other title problem, and leaves ticket titles uncapped", (t) => {
  const title = `fix(babysit): ${"a".repeat(60)}.`;
  const result = check(t, noCiBody, ["pr", "--title", title]);

  assert.equal(result.status, 1);
  assert.deepEqual(result.lines, [
    "title: title is 75 characters, cut it to 72 or fewer",
    "title: title ends with punctuation",
  ]);

  const ticket = `## Problem\n\nA long title.\n\n## Done when\n\n- [ ] **It passes.** Check: exit 0.\n`;
  const ticketResult = check(t, ticket, ["ticket", "--title", `babysit: ${"a".repeat(90)}`]);

  assert.deepEqual(ticketResult.lines, []);
  assert.equal(ticketResult.status, 0);
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

test("counts a Not checked line only outside pasted code, and a Risk line only with its fact", (t) => {
  const body = goodPr
    .replace("**Not checked:** nothing", "```text\n**Not checked:** nothing\n```")
    .replace(/- \*\*Blast radius\.\*\*.*\n/, "- **Blast radius.**  \n");

  const result = check(t, body, ["pr"]);

  assert.equal(result.status, 1);
  assert.deepEqual(result.lines, [
    '13: "## Evidence" has no "**Not checked:**" line, list what has no witness or write nothing',
    '25: "## Risk" has an empty "- **Blast radius.**" line, give the fact',
  ]);
});

function prWithWhyOf(words: number) {
  return goodPr.replace(
    "A reviewer cannot tell whether a PR's proof ran. Closes #47.",
    `${"word ".repeat(words).trim()}\n\n\`\`\`text\n${"pasted ".repeat(50)}\n\`\`\`\n\nCloses #47\nPart of #40\nDepends on #46`,
  );
}

test("caps the Why at 180 words of prose, not counting pasted code or ticket lines", (t) => {
  assert.deepEqual(check(t, prWithWhyOf(180), ["pr"]).lines, []);

  const long = check(t, prWithWhyOf(181), ["pr"]);

  assert.equal(long.status, 1);
  assert.deepEqual(long.lines, ['1: "## Why" has 181 words of prose, cut it to 180 or fewer']);
});

test("warns on a sentence about how the work was produced, without failing the body", (t) => {
  const body = goodPr
    .replace("Closes #47.", "It carries two intermediate PRs. Closes #47.")
    .replace("- **Door.**", "- **Door.** Two-way, like final PR B.\n- **Ignored.**")
    .replace("## this line is inside a fence", "the integration branch, inside a fence");

  const result = check(t, body, ["pr"]);

  assert.equal(result.status, 0);
  assert.deepEqual(result.lines, [
    '3: warning: "intermediate PRs" tells how the work was produced, describe the change at this head for a reader who has only the base, the diff, and the tickets',
    '26: warning: "final PR" tells how the work was produced, describe the change at this head for a reader who has only the base, the diff, and the tickets',
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

function ticketWith(...paragraphs: string[]) {
  return `## Problem\n\n${paragraphs.join("\n\n")}\n\n## Done when\n\n- [ ] **It works.** Check: run it.\n`;
}

// The body from the ticket that found the inline code blind spot: it names the babysit
// own-reply marker in inline code.
const markerLine =
  "The watcher tags its own replies with `<!-- pi-event:reply -->` so it can skip them.";

test("passes a body that quotes an HTML comment inside inline code", (t) => {
  const ticketResult = check(t, ticketWith(markerLine), [
    "ticket",
    "--title",
    "babysit: own replies wake the agent",
  ]);

  assert.deepEqual(ticketResult.lines, []);
  assert.equal(ticketResult.status, 0);

  const pr = goodPr.replace(
    "A reviewer cannot tell whether a PR's proof ran.",
    `${markerLine} A double \`\`run with \` inside <!-- -->\`\` is code too.`,
  );

  const prResult = check(t, pr, ["pr", "--title", "fix(babysit): skip own replies"]);

  assert.deepEqual(prResult.lines, []);
  assert.equal(prResult.status, 0);
});

test("passes a comment quoted in a code span that wraps a line, or escaped into text", (t) => {
  const result = check(
    t,
    ticketWith(
      "The marker is `<!-- pi-event:\nreply -->` across two lines.",
      "An escaped \\<!-- marker --> renders as text, not a comment.",
      "> A quote names `<!-- pi-event:reply -->` too.",
    ),
    ["ticket"],
  );

  assert.deepEqual(result.lines, []);
  assert.equal(result.status, 0);
});

test("flags an HTML comment outside backticks on a line that also holds inline code", (t) => {
  const body = ticketWith(
    "Tag replies with `<!-- pi-event:reply -->`. <!-- Who hits it. -->",
    "A backtick run closes only on a run of its own length: `<!-- left in -->``",
    "An escaped \\`<!-- left in -->` backtick opens no span.",
    `Two backslashes escape each other, so ${"\\".repeat(2)}\`safe\` <!-- left in --> \`tail\` holds two spans.`,
  );

  const result = check(t, body, ["ticket"]);

  assert.equal(result.status, 1);
  assert.deepEqual(result.lines, [
    "3: template comment left in, replace or delete it",
    "5: template comment left in, replace or delete it",
    "7: template comment left in, replace or delete it",
    "9: template comment left in, replace or delete it",
  ]);
});

test("reads a backtick after an even run of backslashes as a span opener", (t) => {
  const body = ticketWith(
    `Two backslashes: ${"\\".repeat(2)}\`<!-- pi-event:reply -->\`.`,
    `Four backslashes: ${"\\".repeat(4)}\`<!-- pi-event:reply -->\`.`,
    `One backslash escapes the first backtick: \\\`safe\` <!-- quoted --> \`tail\`.`,
  );

  const result = check(t, body, ["ticket"]);

  assert.deepEqual(result.lines, []);
  assert.equal(result.status, 0);
});

test("opens no code span on a backtick inside an HTML tag, a link destination, or an autolink", (t) => {
  const body = ticketWith(
    'The <span title="`"> <!-- bare template --> ` end.',
    "The [link](https://example.com/`) <!-- bare template --> ` end.",
    "The <https://example.com/`> <!-- bare template --> ` end.",
    'The <span title="`"> \u2014 ` end.',
    'The <span title="`"> `<!-- code -->` end.',
  );

  const result = check(t, body, ["ticket"]);

  assert.equal(result.status, 1);
  assert.deepEqual(result.lines, [
    "3: template comment left in, replace or delete it",
    "5: template comment left in, replace or delete it",
    "7: template comment left in, replace or delete it",
    "9: long dash, use a period or a comma",
  ]);
});

test("flags a long dash in prose and in a raw comment, but not in quoted code", (t) => {
  const body = ticketWith(
    "It prints `error \u2014 no such file` and exits 1.",
    "It prints `error` \u2014 and exits 1.",
    "The <!-- ` \u2014 ` --> end.",
    "    an indented code block \u2014 with <!-- a quoted comment -->",
  );

  const result = check(t, body, ["ticket"]);

  assert.equal(result.status, 1);
  assert.deepEqual(result.lines, [
    "5: long dash, use a period or a comma",
    "7: long dash, use a period or a comma",
    "7: template comment left in, replace or delete it",
  ]);
});

test("reads an image's alt text as Markdown, so only its bare comments and dashes count", (t) => {
  const body = ticketWith(
    "The screenshot is ![<!-- replace the alt -->](shot.png).",
    "The screenshot is ![`<!-- code -->`](shot.png).",
    "The error is ![`error \u2014 no such file`](shot.png).",
    "The error is ![error \u2014 no such file](shot.png).",
  );

  const result = check(t, body, ["ticket"]);

  assert.equal(result.status, 1);
  assert.deepEqual(result.lines, [
    "3: template comment left in, replace or delete it",
    "9: long dash, use a period or a comma",
  ]);
});

test("reports a comment inside an HTML block on the line that holds it", (t) => {
  const body = ticketWith("<details>\n<summary>Logs</summary>\n<!-- paste the log -->\n</details>");

  const result = check(t, body, ["ticket"]);

  assert.equal(result.status, 1);
  assert.deepEqual(result.lines, ["5: template comment left in, replace or delete it"]);
});

test("reads an indented line after a link definition as the paragraph GitHub renders", (t) => {
  const body = ticketWith(
    "[ref]: /url\n    <!-- bare --> end.",
    "[ref2]: /url\n    Text \u2014 end.",
    '[ref3]: /url "title"\n    <!-- bare --> end.',
    "[ref4]: /url\n    `<!-- quoted -->` and `\u2014` end.",
    "[ref5]: /url\n\n    <!-- indented code --> \u2014",
  );

  const result = check(t, body, ["ticket"]);

  assert.equal(result.status, 1);
  assert.deepEqual(result.lines, [
    "4: template comment left in, replace or delete it",
    "7: long dash, use a period or a comma",
    "10: template comment left in, replace or delete it",
  ]);
});

test("reads a GitHub footnote's indented continuation as footnote prose, not code", (t) => {
  const body = ticketWith(
    "A footnote[^a] and another[^b] and a third[^c].",
    "[^a]: Text\n    <!-- bare --> end.",
    "[^b]: Text\n    \n    <!-- bare --> end.",
    "[^c]:\n    - Text\n      \n      <!-- bare --> end.",
  );

  const result = check(t, body, ["ticket"]);

  assert.equal(result.status, 1);
  assert.deepEqual(result.lines, [
    "6: template comment left in, replace or delete it",
    "10: template comment left in, replace or delete it",
    "15: template comment left in, replace or delete it",
  ]);
});
