---
name: writing-good-prs
description: Write or update a pull request title and body that a reviewer can verify in a minute. Use when opening a PR, editing its description, or writing a squash commit body.
user-invokable: false
---

# Writing good PRs

A PR body is a one-minute briefing for a reviewer who has the diff open. It becomes the squash commit body, so it is also what a maintainer reads in `git log` months later. It shows the change, proves the change works with a before and an after, and says how risky the merge is.

When the repository has a PR template, fill the template's sections, and apply the rules below to the section that plays each role. Otherwise use the shape below.

Write the prose with the **technical-writing** skill (every layer except Diátaxis), then the **unslop** skill.

## Title

Use Conventional Commits, `type(scope): subject`, with no trailing period. The scope is the area, such as `subagents` or `web`.

- For `feat` and `fix`, the subject is the outcome a user sees, in plain words: `fix(web): new threads no longer spike CPU`.
- For `refactor`, `chore`, `test`, `docs`, and `perf`, the subject names the symbol or file that carries the change: `refactor(pstack-port): name each invocation for who can load the skill`.

## Body

```markdown
## Why

## Shape

## Evidence

## Merge danger

## Scope

## Tradeoffs

Made by <model> in <harness>.
```

Drop `## Shape` and `## Tradeoffs` when they have nothing to say. Start at `## Why` with no preamble. Write short sentences with few identifiers, and keep the body to 40 non-blank lines. Full SHAs, swarm or arena lane recitals, the story of how the tooling got fixed, file-by-file checklists, metric tables, and review verdicts go in a linked artifact.

### Why

Give the problem and the approach in 1 to 3 sentences. Link the ticket with `Closes #N`. Leave out SHAs, rebase history, and "based on main" notes.

### Shape

Give one small visual that shows the change before the reviewer reads the diff. Pick the smallest view that makes the point:

- Pseudocode for logic.
- A call tree for control flow.
- A shallow file tree for a layout change or a broad refactor.
- A `diff` block of one of these when the surrounding shape already exists.
- Mermaid for messages between components.

```diff
 submitForm
   createSession
     persistPrompt
+    expandSkillMention
     launchAgent
```

Keep only the calls, files, and boundaries the reviewer needs. Name both sides of a rename or retarget. Skip the section when the change fits in one sentence.

### Evidence

Prove the change works on the real surface, as a before and an after, in 1 to 3 items, or one item for each `## Done when` item of the ticket it closes. Strongest first:

1. Media from the running product, captured through the repository's `verify-*` skill. Use a screenshot for a static state and a recording for motion, timing, or interaction. Add a half-speed copy when timing is the point. For a TUI or CLI, the captured pane or output text in a fenced block is the media.
2. A test that fails on the base and passes on the head, named by file and case. A mutation check is stronger, because it shows the test fails again when the fix is removed.
3. Command output that changed, before and after.

"Tests pass" and "typecheck passes" are claims, so they count only as context next to one of these. Capture the before on the base branch. Put image pairs side by side in a `| Before | After |` table. Give each media item a caption or alt text that says what to look at. When the PR closes a ticket, prove each of its `## Done when` items. List what you could not check, and why.

For a perf change, give one primary number with its unit as `before → after`, and link the benchmark directory for the sample sizes, the method, and the other numbers, per the **benchmark-checklist** skill.

Host media through the repository's own uploads when it has them, and otherwise with the **dumpfile** skill. Dumpfile links expire after 30 days, so the text next to each link says what it showed. Keep PR-only screenshots and recordings out of the repository.

### Merge danger

Say whether the change is a one-way door or a two-way door, and name its blast radius.

- A two-way door is cheap to revert.
- A one-way door survives a revert: deleted or migrated data, a published package, a removed public API, a message sent to people, or a changed default that other machines pick up. Say why it is safe and how to recover.
- The blast radius is who or what breaks if the change is wrong, such as consumers of an API, a layout at phone width, or every subagent launch.

Keep the section to 1 or 2 sentences.

You wrote the change, so this is a self-graded call. Before you write "two-way door" with a small blast radius, name the one fact that makes it true. If the base branch is red, state the cost of leaving it red.

### Scope

Give 1 to 3 items on what the PR covers and what it deliberately leaves out, such as a follow-up or a known gap. Write them in plain words, without symbols or paths. One PR solves one problem.

### Tradeoffs

Name only the rejected alternatives a reviewer would otherwise ask about.

### Attribution

End with the model and harness that did the work, such as `Made by Claude Opus 5.5 in Pi.`

## Check the body

Write the body to a file, then run:

```bash
scripts/check-body.ts pr <body-file> --title "<title>"
```

Add `--template <path>` when the repository has a PR template, so the check takes the section headings and their order from it. Each output line names one problem. Fix each one and rerun until the check exits 0, then pass the same file to `gh pr create --body-file` or `gh pr edit --body-file`. The check covers the structure. Whether the Evidence shows the right before and after stays your call.
