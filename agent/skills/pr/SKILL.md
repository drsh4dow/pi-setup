---
name: pr
description: "Use when writing or updating a PR title or body."
metadata:
  credits:
    skill: show-me
    author: Dex Horthy
    organisation: Humanlayer
    url: "https://github.com/humanlayer/skills/blob/main/plugins/show-me/skills/show-me/SKILL.md"
---

# PR

Write a PR a reviewer can judge from the page alone: what was wrong, what
changed, proof that it works, and where their judgment is needed.

## Before writing

1. Find the repository's convention: a PR template
   (`.github/pull_request_template.md` or `.github/PULL_REQUEST_TEMPLATE/`),
   the PR section of `CONTRIBUTING.md`, and PR rules in the workspace
   instructions. They bind. Use their headings, fill every field they ask for,
   and put the content below under the heading that fits.
2. Read the final diff against the base branch and the ticket or issue it
   resolves. Describe the diff as it stands now. After review pushes, rewrite
   the body to match; the review history lives in its threads.
3. Launch the merge danger audit now, so it runs while you write. See
   [Merge danger](#merge-danger).

## Title

Write the title with the `writing-good-commits` skill, since a squash merge
turns it into the commit subject. Phrase a fix as the behavior after it:

- `fix(web): links in HTML renders open like chat links`
- `fix(server): stop fsyncing SQLite on every commit so slow disks no longer
  drop clients`

## Body

```markdown
<ticket link, or `Closes #n`>

## Problem

## Change

## Verification

## Review notes

## Scope

## Merge danger

Made with <model> in <harness>.
```

Problem, Change, Verification and Merge danger are always present. Omit any
other section that would only say "none". Size the body with
[Before saving](#before-saving). Use the project's domain terms, from
`GLOSSARY.md` when it exists.

### Problem

One or two sentences. Lead with what a user or operator saw, then the cause.
Link the report and the evidence behind it: the issue, log query, or thread.

### Change

Explain in prose how the change fixes the problem. Name each tradeoff and what
it costs. When the change spans components, say why each one belongs to the
same fix.

When structure, control flow or state changed, add the smallest sketch that
shows it. Pick one from [VISUALS.md](VISUALS.md) and place it beside the
sentence it supports. Show changed user-facing text as a table of old and new
copy.

### Verification

Proof that the changed behavior works, with numbers.

- For a visual change, show before and after for each case, cropped to the
  changed region at 2x zoom. For narrow regions use a
  `| Case | Before | After |` table; for wide ones use one labeled image with
  before above after. Add a recording when motion, timing or interaction
  matters.
- Name the test that pins the change and how it failed without it:
  "`test_reason` fails on the base branch with `expected 2 to equal 1`."
- Give measurements as before → after, with the setup that produced them.
- List the commands you ran with their pass counts. Mark failures that also
  occur on the base branch.
- State what you could not check, and why.
- When a reviewer can reproduce the change, end with the steps: where to run
  it, what to do, and what they should see.

Upload images and recordings with the `dumpfile` skill or the repository's own
asset host, and embed the links. Keep PR-only assets out of the repository.
Evidence uses synthetic data.

### Review notes

Where the reviewer's judgment is needed:

- Decisions a reviewer might reverse, each with the alternative and why it
  lost.
- Review findings left unfixed, each with its reason.
- Rules the change does not follow, as exceptions: the rule ID, the reason,
  and the end condition.
- Where to start reading, when the diff spans many files.

### Scope

What the PR leaves out on purpose, and the follow-ups it implies, linked when
filed. Independent fixes go in separate PRs.

### Merge danger

How much damage the change does if it fails, so reviewers can size their
trust and their effort. Correctness belongs to review; this section takes the
failure as given.

An audit subagent writes it, because the author frames a change by its intent
and misses what the code reaches. Launch one with the `subagents` skill. Its
assignment names the repository, the base ref and the ticket, and tells it to
follow [MERGE-DANGER.md](MERGE-DANGER.md) by absolute path. Keep your own
reasoning and draft body out of it.

Paste the Severity, Door and Blast radius lines it reports. For medium or high,
also list its widest-reach parts, with `file:line`, under Review notes as where
to start reading. You may raise the level and must give the reason; the level
stays at or above the audit's. Put any disagreement under Review notes. If the
audit fails, write `**Severity:** unrated` and treat the change as high. Rerun
the audit after every push that changes code.

When the level is high, propose to the user how to shrink the reach before
opening the PR: move the high-reach part into its own PR, put it behind a flag
that is off by default, make a migration additive, or dry-run a backfill.

When the user changes a rating, append the case to Calibration in
[MERGE-DANGER.md](MERGE-DANGER.md): what the diff did, the level, and why.

## Before saving

Count the body's words, Merge danger included and evidence links and images
excluded. The body is done when it fits the budget for the diff's changed
lines:

| Changed lines | Words |
| ------------- | ----- |
| under 50      | 300   |
| 50 to 500     | 600   |
| over 500      | 1,000 |

Cut investigation history first. The reviewer needs what was wrong, what
changed and the proof, not how you found it; that story belongs in the ticket.
Meet the budget by removing whole sentences, and keep every remaining one a
complete sentence.
