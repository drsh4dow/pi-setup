---
name: writing-good-tickets
description: Write, file, or update an issue or ticket that an agent or a developer can take to one PR. Use when filing a bug or feature, updating an issue, or breaking a plan into tickets.
disable-model-invocation: true
user-invokable: false
---

# Writing good tickets

A ticket hands one problem to someone who was not in the conversation, a developer or an agent, who takes it to one PR. It answers, in order: what goes wrong today and for whom, what shows it, how anyone will know it is fixed, and what to read before starting. The closing PR proves each `## Done when` item with a witness, per the **writing-good-prs** skill.

Edit the prose with the **unslop** skill. Follow the repository's tracker and template conventions, starting from its issue tracker record, `docs/agents/issue-tracker.md`, when it has one. When the repository has an issue template, fill its sections and apply the rules below to the section that plays each role.

Everything the ticket points at is reachable by any developer with access to the repository: issues, PRs, CI runs, hosted media, and public URLs. Paths on your machine, such as your home directory, `/tmp`, a worktree, or an agent state folder, are reachable only by you. Paste what they hold instead. Say "on main" or name the released version where you saw it, rather than a commit hash.

## Title

Write `area: symptom`, with no trailing period: the trigger and what the reader sees, for one failure. A cause or a remedy stays out of the title, because the symptom stays true when the guessed cause turns out wrong.

- Good: `subagents: an autonomous run sends one unit through five fix rounds until the operator stops it`
- Bad: `subagents: an autonomous run has no round count per unit, so nothing stops a third fix round`, which names the missing mechanism instead of what the reader saw.

## Body

```markdown
## Problem

## Done when

- [ ] 

## Suggested approach

## Context
```

`## Problem` and `## Done when` are required. Drop any other section with nothing to say.

### Problem

1. **Open with one story, in the present tense.** Who hits it, the trigger, what happens, what should happen, and what it costs. For a feature, the story is the person and the moment the current behavior fails them, quoted in their words when you have them. This story is the baseline: the closing PR is judged by whether the same story now ends differently.
2. **Show the witness.** Paste the decisive lines: output, a log excerpt, a screenshot, or a quoted report, with where you saw it and how often, such as `3 of 3 runs`.
3. **Give the recipe.** The exact steps, run from a fresh clone of the repository after its normal setup. Say whether you reproduced it yourself, and write `reported, not reproduced` when you did not.

Preserve the nuances from the conversation that an implementer would otherwise lose.

### Done when

Each item is one behavior, written so a developer reads what must be true and an agent reads how to check it:

```markdown
- [ ] **<the behavior, in plain words>.** Check: <the setup, the action, and the exact result to observe>.
```

- The check names a surface that anyone can run: a command and the output it must print, a test case and what it asserts, or a walk through the running app with the repository's `verify-*` skill.
- The first item replays the Problem's story with the new ending.
- When the fix could overshoot, give the boundary its own item: what must keep working as before, such as "real `pi --print` launches are still refused".
- A behavior the conversation settled, such as "a missing Java still fails the check", is an item here.
- An unknown that running something can settle is an item too, such as "**The faster layout is kept.** Check: prototype both and keep the one that renders in under 16 ms."
- Repository gates such as `vp run verify` go last, and never stand alone.

A ticket that still waits on a product call only a person can make is not ready. Ask that person before you file.

### Suggested approach

Optional, and never binding: the implementer owns the how. Give it when you hold something that would save them time:

- The cause you suspect, marked `Hypothesis` with what you saw that points to it.
- A possible approach and the alternative you would rule out, with the reason.
- A visual from the **writing-good-prs** Shape menu when it shows the idea faster than prose.

Name behavior and symbols, not file paths. Finding where a symbol lives is one search.

### Context

List the material the implementer reads before starting that neither a code search nor the tracker gives them, each with one line on why it matters:

- Docs, specs, and external URLs the fix must follow.
- Attachments: logs, screenshots, recordings, and data, hosted where everyone can open them.

Relate other issues and PRs through the tracker itself, as a parent, a blocker, or a sub-issue, per the issue tracker record, so the link lives in one place. When another issue settled something this ticket depends on, state what it settled in Problem or Done when.

## Example

The same ticket, condensed from a real one and written well:

````markdown
delegate-guard: a delegate's read-only grep for launch strings is refused as a launch

## Problem

When a reviewer subagent greps the code for launch strings, the guard refuses the read-only search with "Delegates spawn nothing", so the reviewer cannot read the guard it is reviewing. None of these commands starts Pi. Reproduced on main, 3 of 3 runs, by saving this as `repro.ts` in a clone and running `bun repro.ts`:

```ts
import { spawnGuard } from "./agent/extensions/delegate-guard.ts";
const guard = spawnGuard(["node", "pi", "--print"])!;
for (const cmd of [
  "grep -nE 'pi-subagent|pi --print' delegate-guard.ts",
  'rg "foo; pi -p" .',
]) console.log(cmd, guard(cmd) === undefined ? "allowed" : "BLOCKED");
```

```text
grep -nE 'pi-subagent|pi --print' delegate-guard.ts BLOCKED
rg "foo; pi -p" . BLOCKED
```

## Done when

- [ ] **A delegate can search for launch strings.** Check: `delegate-guard.test.ts` runs both commands above as a delegate, and the guard allows each.
- [ ] **Real launches are still refused.** Check: the existing launch cases, including heredoc and `bg_start` launches, are still blocked.
- [ ] **The repository gate passes.** Check: `vp run verify` exits 0.

## Suggested approach

Hypothesis: the guard splits commands on `;` and `|` inside quotes, so the quoted words read as a `pi --print` command. Teaching the splitter shell quoting would fix it. Allowing every command that starts with `grep` or `rg` would not, because `rg x; pi -p` would then start Pi.

## Context

- The subagents skill's Kinds section defines delegates and owners and why a delegate starts nothing. The fix must keep that rule.
````

The same ticket, written badly:

```markdown
delegate-guard: improve command parsing

## Problem

The regex in delegate-guard is broken and blocks valid commands. See /tmp/reflect-result.md.

## Done when

- [ ] Use a proper parser
- [ ] Add tests
```

Its title names a remedy instead of a symptom. Its Problem states a guessed cause as fact, names nobody who is hurt, and points at a file only its writer can open. Its Done when prescribes code instead of a behavior, gives no check anyone could run, and leaves out the boundary: nothing says real launches must still be refused.

## Size

Size each ticket as a vertical slice. It cuts a narrow path through every layer it needs, is verifiable on its own, and fits in one agent session. Split a wide refactor into an expand ticket, migrate tickets in batches, and a contract ticket, each blocked by the one before.

## Before you file

- Search the tracker for the same symptom, error text, and area. For a confident duplicate, add the new evidence to the existing issue instead of filing. For a possible match, file the new ticket, then comment on the match with a link to it and say why it is not a duplicate.
- For complex agent-facing workflow instructions inside a ticket, use the **writing-for-agents** skill.

## Check the body

Write the body to a file and run both gates.

1. **Structure.** Run `../writing-good-prs/scripts/check-body.ts ticket <body-file> --title "<title>"`, with `--template <path>` when the repository has an issue template. Fix each printed problem and rerun until it exits 0. Exit 0 means the headings and title parse. It says nothing about the case the body makes.
2. **Implementer read.** Give one subagent in the `cross-family reviewer` role, per the **subagents** skill, only the title and the body file. Ask it to:
   1. Retell the problem as one story, with who it costs, and name the witness that shows it, or write `none visible`.
   2. For each Done-when item, say exactly what it would run and what result counts as done, or write `unclear`.
   3. As the implementer, list what it would still need to start, or write `nothing`.

   Run the read once. Fix every gap its answers show, then move on without a second read.

   A delegate launches no subagent, so it writes the body file and names this read in its report for its parent to run.

Publish the same file through the tracker, then read the ticket back and compare what the tracker stored with the title and the body file. On GitHub, publish with `gh issue create --body-file` or `gh issue edit --body-file`, read back with `gh issue view <n> --json title,body`, and diff the body with `gh issue view <n> --json body --jq .body | diff <body-file> -`. Fix each difference at its cause, such as a shell expansion or a template the tracker applied, republish, and read it back once more. Report any difference that remains.
