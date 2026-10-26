---
name: writing-good-prs
description: Write or update a pull request title and body that a reviewer can trust and own. Use when opening a PR or editing its description.
disable-model-invocation: false
user-invokable: false
---

# Writing good PRs

A PR body is the case a reviewer reads before the diff: what is wrong today, why this change fixes it, what it looks like, the proof that it works, and what it puts at risk. Write the Why the way the **writing-good-commits** skill writes a commit body. Write the Evidence for an expert in the field who must own this change after it merges. The test: that expert can retell the problem and the reason for the fix, and has every question they would ask about the proof answered in the PR, without cloning the branch.

Write it the way one engineer explains a change to another: plain words, one idea per sentence, and only terms the reader would not stop to ask about. Then edit it with the **unslop** skill. When the repository has a PR template, fill its sections and apply the rules below to the section that plays each role.

## Title

Follow the subject rules of **writing-good-commits**: `type(scope): subject`, imperative, completing "If merged, this PR will …", within 72 characters. Name the one change the PR makes, bounded by what Evidence proves. A title that promises "no process outlives its launcher" fails when Risk lists a process that still does.

## Body

```markdown
## Why

## Shape

## Evidence

## Risk
```

Start at `## Why` with no preamble. Drop `## Shape` only when the change fits in one sentence.

Write for a reader who has only the base branch, this diff, and the tickets the PR links, and describe the change as it stands at this PR's head. How the work was produced, such as the earlier PRs that built it, the branches it passed through, who verified it, and the review rounds, belongs in the commit list and on the tickets. Name another PR only when this one needs it to merge, deploy, or make sense, by its number and with what it does.

Everything the body points at is reachable by any developer with access to the repository: files linked on the default branch, issues, PRs, CI runs, and hosted media. Paths on your machine, such as your home directory, `/tmp`, a worktree, or an agent state folder, are reachable only by you. Paste what they hold instead. Say "before this PR" and "after this PR" rather than commit hashes.

### Why

Two short paragraphs, at most 180 words, walking the commit body's chain:

1. **The problem as one story, in the present tense.** Who hits it, the trigger, what happens, and what it costs them. Then the cause, when it explains the fix. "A reviewer subagent that greps the code for `pi --print` is refused, so it cannot read the guard it is reviewing. The guard splits a command on `;` even inside quotes, so quoted search text looks like a launch."
2. **The change, why it removes the cause, and the alternative a reviewer would propose**, with the fact that rules it out. Skip the alternative when no real one exists.

Then one line per ticket: `Closes #N` for a ticket this PR finishes, and `Part of #N (<what this PR does for it>)` for one it advances, with what that ticket still owes posted on the ticket. Add `Depends on #N` when another PR must merge first. Name behavior in plain words, and keep identifiers to the ones a reviewer needs to find the code. Leave the line-by-line how to the diff and the process out: commands you ran, review rounds, rebases.

### Shape

Show the change before the reviewer reads the diff. Pick the smallest view that makes the point, and use several when the change has several kinds of shape:

- Pseudocode for logic or an algorithm:

  ```text
  on(save)
    if content is unchanged
      return cached result
    write new content
  ```

- A call tree for runtime control flow, or a component tree for UI structure, with the state and module boundaries that matter.
- A shallow file tree for file responsibility or a broad refactor.
- Mermaid for messages between components, control flow, or data flow. GitHub renders it in the PR:

  ```mermaid
  sequenceDiagram
      participant Delegate
      participant Guard
      Delegate->>Guard: bash "rg 'pi --print'"
      Guard-->>Delegate: allowed
  ```

- A `diff` of any of these when the surrounding shape already exists and the point is what changes:

  ```diff
   submitForm
     createSession
       persistPrompt
  +    expandSkillMention
       launchAgent
  ```

- The whole block when most of it is new, or when omitted context would hide ownership or order.

Place each visual next to the sentence it supports. Keep only the calls, files, states, and boundaries the reviewer needs, and name both sides of a rename.

### Evidence

Evidence answers two things: does the change do what the Why claims, and what would an expert in this field ask before trusting that? Its length is whatever those answers need. Order it so the decisive proof comes first.

**Claims.** Give one item for each claim the title and Why make, and one for each `## Done when` item of the ticket the PR closes. Each item is a **witness**: an observation the reviewer sees in the PR itself.

````markdown
- **<claim or Done-when item>.** <setup and action, one sentence>, `<command>`:
  ```text
  before  <the output that shows the problem>
  after   <the output that shows it gone>
  ```
````

- Run each witness at this PR's head. A run on another PR's head proves that head, so rerun the check here or list the claim under Not checked.
- Paste or link the observation. A sentence that reports a result is a claim. "The base leaves the Pi running and the head leaves nothing" becomes the process listing from both runs.
- Show the counterfactual: the same check before and after this PR. For a new regression test, paste its failure without the fix, then its pass with it.
- **A change a user can see or touch** opens Evidence with two witnesses, captured on the running product through the repository's `verify-*` skill:
  - Before and after screenshots of the same screen in the same state, side by side in a `| Before | After |` table.
  - A recording of you dogfooding the change as a real user: from the entry point a user would take, through the interaction, to the result. Add a half-speed copy when timing is the point.

  For a TUI or CLI, the captured pane is the screenshot and a terminal recording is the video.
- Match every other witness to its claim: a process listing for liveness, and for a perf claim one `before → after` number with its unit and a link to the method, per the **benchmark-checklist** skill.
- A before/after table works well for many cases of one check. Put the full log in a `<details>` block under the decisive lines.
- "Tests pass", "typecheck passes", and "`vp run verify` passed" are claims. They count only with their output or a CI link.

**Expert questions.** Then answer the questions a skeptical expert in this domain would ask about the proof, each as a bold question with its witness:

- Does the test fail without the fix, or would it pass anyway?
- Does the proof run on the surface where the bug was seen, or on a stand-in? If a stand-in, how close is it?
- For a change a user sees: does it hold when a real user drives it end to end, including the empty, error, and narrow-screen states?
- What is the nearest case that should still behave as before, and does it? For a guard or a security check, which bypasses were tried?
- For the rejected alternative in the Why: what shows it fails?
- For a number: what was the sample size, the spread, and the setup?

Ask the questions that fit this change and skip the ones that do not apply.

**Not checked.** End with `**Not checked:**` and each claim, Done-when item, or expert question that has no witness, with the reason. Write `nothing` when everything has one.

Caption each screenshot and recording with what to look at. Host media through the repository's own uploads when it has them, and otherwise with the **dumpfile** skill. Dumpfile links expire after 30 days, so each caption says what the media showed. Keep PR-only media out of the repository.

### Risk

Answer three labeled lines, each with the fact behind it:

- **Blast radius.** Who or what is exposed if the change is wrong, what failure they would see, and how anyone would notice. "Every command a delegate runs goes through this parser. A wrong parse either stalls a subagent on a harmless command or lets a delegate start Pi, which nothing else would catch."
- **Door.** Two-way when a revert undoes everything. One-way when something survives a revert: migrated data, a published package, a removed public API, a sent message, or a changed default that other machines pick up. Name the fact that decides it, and for a one-way door, how to recover.
- **Merge condition.** What must be true before this merges, such as a regression found in Evidence being fixed or `#N` merged first. Write `none` when it can merge as is.

## Example

The same PR, condensed from a real one and written well:

````markdown
fix(background-terminals): deliver unread notifications with the terminal's end

## Why

When a background terminal ends, the model never sees the notifications it had not read yet. A watcher that reports `a-61`, then `b-62`, and is then killed leaves the model with only `a-61`, so it acts on partial information. The session deletes a terminal's pending notifications when the terminal ends.

The report of the terminal's end now carries them. Sending each one ahead of the end was rejected: Pi steers one message per poll, so each would cost the model an extra request.

Closes #73

## Shape

```diff
 terminal ends
-  delete its pending notifications
+  attach its pending notifications to the end report
   wake the model with the end report
```

## Evidence

- **A killed watcher's second notification reaches the model** (Done when 1). A `pi --print` run whose watcher the model kills on its first notification, so the change has no screen to capture:
  ```text
  before  model reply: a-61 end
  after   model reply: a-61 b-62 end
  ```
- **Does the regression test fail without the fix?** Yes. `test/steering.test.ts` "a terminal that notifies and exits during a turn":
  ```text
  before  ✖ expected note-42 once, received 0 times
  after   ✔ a terminal that notifies and exits during a turn
  ```
- **Can a notification now arrive twice?** The TLA+ model checks this as `NoDoubleWake`. It holds after this PR:
  ```text
  TerminalDelivery.cfg: NoDoubleWake holds
  ```

**Not checked:** macOS, because the e2e suite runs only on Linux here.

## Risk

- **Blast radius.** Every session that uses background terminals. A wrong batch would give the model a notification twice or not at all, and the model would act on the wrong state without saying so.
- **Door.** Two-way. Pending notifications live in memory, so a revert restores the old behavior with nothing to migrate.
- **Merge condition.** none
````

The same PR, written badly:

```markdown
fix(background-terminals): a notification reaches the model when its terminal ends first

## Why

`delivery.terminalSettled(id)` deleted pending notifications. Now `batch("completion")` appends them and `bg_kill` lists them. This is the final PR of the stack: it carries intermediate PRs #71 and #72, and final PR B adds the docs. Closes #73.

## Evidence

- The TUI reply is `a-61 end` on stack-base and `a-61 b-62 end` here.
- `test/steering.test.ts` fails on stack-base and passes here.
- `vp run verify` passes.

## Risk

Two-way door. Blast radius: background terminals.
```

Its Why lists symbols instead of a story, so the reader never learns what the model loses, and it gives no reason for the approach. It tells how the work was produced, which the reader of this diff cannot use, and names a PR by a letter only its author knows. It has no Shape. Its Evidence reports results instead of showing them, names a branch instead of before and after, counts "passes" as proof, and leaves every expert question open. Its Risk names a door without the fact behind it and never says who would be hurt.

## Check the body

Write the body to a file and run both gates.

1. **Structure.** Run `scripts/check-body.ts pr <body-file> --title "<title>"`, with `--template <path>` when the repository has a PR template. Fix each printed problem and rerun until it exits 0. Exit 0 means the headings, the title's form and length, and the Why length pass. It says nothing about the case the body makes. A `warning:` line leaves the exit code alone and marks a sentence about how the work was produced. Rewrite it for the reader of this diff, or keep it when that reader needs it to merge or deploy.
2. **Expert read.** Give one subagent in the `cross-family reviewer` role, per the **subagents** skill, only the title and the body file, with no diff, ticket, or chat. Ask it to:
   1. Retell the problem as one story, and why this fix rather than the alternative.
   2. As an expert in this domain who must own the change, list every question it would need answered to trust the proof. For each, quote the line that answers it, or write `unanswered`.
   3. State the blast radius and the door, or write `unclear`.
   4. Quote every sentence it could follow only by knowing how the work was produced, such as other PRs or branches named without what they do, or who checked what. Write `none` when there is none.

   Run the read once. Answer every `unanswered` and `unclear` it reports with a witness, or list it under Not checked. Rewrite every quoted sentence as a fact about this PR's change. Then move on without a second read.

   A delegate launches no subagent, so it writes the body file and names this read in its report for its parent to run.

Publish the same file with `scripts/publish-pr.ts create <body-file> --title "<title>"` or `scripts/publish-pr.ts edit <number> <body-file> --title "<title>"`, never with a bare `gh pr create --body-file` or `gh pr edit --body-file`. `create` also takes `--base`, `--head`, and `--repo`, `edit` takes `--repo`, and both take `--template`. Keep the title out of the body file.

- It reruns check-body and calls no `gh` unless check-body exits 0.
- On `edit`, it keeps each `## ` section that the live body has and the file lacks, such as a plan a bot appended, in its live position, and prints `publish-pr: kept "## <heading>" from the live body` for each. If you deleted that section on purpose, say so in your report.
- It reads the PR back and compares it with what it sent, ignoring line ends and trailing newlines. On a difference it prints the changed lines.

Its exit code is 0 when the PR is published and reads back the same, 1 when check-body found problems, 64 for a bad argument, 2 when a `gh` call failed or check-body could not run, and 3 when the readback differs.
