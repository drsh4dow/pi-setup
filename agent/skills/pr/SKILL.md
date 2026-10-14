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

Problem, Change and Verification are always present. Omit any other section
that would only say "none". Scale each section to the diff: a 20-line fix gets
a sentence or two per section. Use the project's domain terms, from
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

**Door:** one-way or two-way. A two-way door is one that a revert fully undoes.
Migrations, deletions, backfills, published contracts and sent messages make a
door one-way; name what cannot be undone.

**Blast radius:** what breaks if the change is wrong, such as a screen, a job,
API consumers, or a data set.
