---
name: writing-good-tickets
description: Write, file, or update an issue or ticket that an agent or a developer can take to one PR. Use when filing a bug or feature, updating an issue, or breaking a plan into tickets.
disable-model-invocation: false
user-invokable: false
---

# Writing good tickets

An issue and a ticket are the same artifact. A ticket is one unit of work that one agent or one developer can take to one PR. Its body has the same sections whoever writes it, so the reader finds the problem, the finish condition, and the decisions in the same place every time.

Follow the repository's tracker and template conventions, starting from its issue tracker record, `docs/agents/issue-tracker.md`, when it has one. When the repository has an issue template, fill the template's sections and apply the rules below to the section that plays each role. Otherwise use the shape below.

## Title

Write `area: symptom or outcome`, with no trailing period, such as `subagents: a Pi with a hanging shutdown outlives a SIGKILLed launcher`. Name what the reader sees. A guessed cause stays out of the title.

## Body

```markdown
## Problem

## Done when

- [ ] 

## Decisions

## Pointers

```

`## Problem` and `## Done when` are required. Drop any other section with nothing to say.

### Problem

- For a bug, give the steps to reproduce, the expected behavior, the observed behavior, the version or commit, how often it happens, and the evidence, such as a screenshot, a log line, or a stack trace. Reproduce it on the reporter's surface before you file, and say whether you did.
- For a feature, say who needs it, the current behavior, and the desired behavior.

Say why it matters. Preserve the nuances from the conversation that an implementer would otherwise lose.

### Done when

Each item is a check that someone can run and observe: a command and its output, a feature walked in the running app through the repository's `verify-*` skill, or a test at a named seam. The PR that closes the ticket proves each item in its `## Evidence` section, per the **writing-good-prs** skill. Items describe completion, so each one does not need its own test.

### Decisions

Sort each decision into one of three lines:

- **Accepted.** Decided, with who decided when that matters.
- **Assumed.** Believed but not confirmed.
- **Open.** A product or preference call that only a person can make.

An unknown that running something can settle is not an open question. Write it as a `## Done when` step instead, such as "prototype both layouts and keep the one that renders in under 16 ms".

### Pointers

Name the symbols, commands, and config keys the implementer starts from. Pin each file path and line to a permalink with a commit SHA, so a stale pointer is visible. Label each cause guess as a hypothesis. Give pointers without prescribing obvious code. Include a diagram or a prototype snippet only when it states a decision more clearly than prose.

Link authoritative context instead of copying it. When essential requirements live in another issue, say that the implementer must read it.

## Size

Size each ticket as a vertical slice. It cuts a narrow path through every layer it needs, is verifiable on its own, and fits in one agent session. Split a wide refactor into an expand ticket, migrate tickets in batches, and a contract ticket, each blocked by the one before.

## Before you file

- Search the tracker for the same symptom, error text, and area. For a confident duplicate, add the new evidence to the existing issue instead of filing. For a possible match, link it and say why this is not a duplicate.
- For complex agent-facing workflow instructions inside a ticket, use the **writing-for-agents** skill.

## Check the body

Write the body to a file, then run:

```bash
../writing-good-prs/scripts/check-body.ts ticket <body-file> --title "<title>"
```

Add `--template <path>` when the repository has an issue template, so the check takes the section headings and their order from it. Fix each printed problem and rerun until the check exits 0, then publish the same file through the tracker, such as with `gh issue create --body-file` or `gh issue edit --body-file` on GitHub.
