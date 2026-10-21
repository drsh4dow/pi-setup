# Run this setup across the software lifecycle

This guide shows how to take work from an idea to a merged PR with this Pi
setup, in a new project and in an established codebase. It is for me, and for
anyone who copies the setup. For what each mode does, read
[`agent/SYSTEM.md`](../agent/SYSTEM.md). For the skills, see
[Installed skills](../README.md#installed-skills).

The setup prevents two failures. Cognitive debt is the code drifting away from
my mental model of it. Cognitive loss is my design skill eroding because the
agent made my design calls. So the agent changes code only after I agree to a
design, and every design states how it will be proven.

## The loop

Every piece of work moves through the same states. The agent names its mode on
the first line of each reply, so I always know which state I am in.

| State     | Event                                    | Next state | What I get                                   |
| --------- | ---------------------------------------- | ---------- | -------------------------------------------- |
| Request   | A question                               | Answered   | A cited answer, and no edits                 |
| Request   | A change, with no agreed brief           | Briefed    | A Design brief                               |
| Request   | A change stated exactly, with a check    | Building   | Nothing yet                                  |
| Briefed   | I agree                                  | Building   | Work on the first package                    |
| Briefed   | I change or reject it                    | Briefed    | A revised brief, rewritten in full           |
| Building  | The proof passes within the line budget  | Verified   | The outcome, the evidence, the agent's calls |
| Building  | The budget overflows or a premise breaks | Briefed    | A report of what the agent learned           |
| Verified  | I say "commit"                           | Committed  | A commit whose body records the decisions    |
| Committed | I ask for PRs                            | In review  | A stack of PRs, one per package              |
| In review | A comment or a red check                 | In review  | A fix, or a dismissal with a reason          |

Two transitions never happen. The agent never goes from Request to Building
without a brief or an exact instruction, and never from Verified to Committed
without my word.

## Which path are you on?

| Signal                      | Greenfield                         | Brownfield                               |
| --------------------------- | ---------------------------------- | ---------------------------------------- |
| Age of the code             | Days to weeks                      | Months to years                          |
| Tests                       | You add them from the first commit | Uneven, and some areas have none         |
| Most expensive mistake      | The wrong data model               | Changing behavior that nobody wrote down |
| First mode                  | Design                             | Answer                                   |
| What a brief spends most on | Data shapes and state tables       | The current system next to the proposal  |

A young project that already has users takes the brownfield path.

## Path A. Greenfield

1. Sharpen the idea. Say who the project is for and how you will know it
   works.

   ```text
   /skill:sharpen
   New project: a web app where an on-call team of five logs incidents and
   reads a weekly summary. It works when someone logs an incident in under a
   minute and Monday's summary lists every incident from the past week.
   ```

2. Ask for the design. The agent answers in Design mode with a brief: the
   data shapes, a state table for each stateful thing, what must never
   happen, at most five shape decisions, and the proof plan.

   ```text
   Design the core data model and module map.
   ```

   Push back in plain words until the shapes fit every case. The agent
   rewrites the whole brief each time.

   ```text
   An incident can be reopened. Model its status so a reopened incident keeps
   its earlier resolution.
   ```

3. Prove the risky part before code. When the design has concurrency,
   retries, or a lifecycle across processes, the brief names a TLA+ model.
   TLA+ is a language that describes a system's states, and its model
   checker tries every order of events against the properties you state.
   Generate it once, so later changes recheck it.

   ```text
   /skill:create-formal-verification-skill
   ```

4. Scaffold the checks before any feature: strict types, lint, one verify
   command, and an `AGENTS.md` that names it. This is a package of its own.
5. Build the first feature, one package at a time. Agreement on the brief
   opens Build. The agent stops at its line budget, so a package never grows
   past what you agreed to read.
6. Once a user can reach the feature, generate the verify skill. From then on,
   every package proves itself on the running app.

   ```text
   /skill:create-verification-skill
   ```

## Path B. Brownfield

In old code, the danger is not building the wrong thing. It is changing
behavior that nobody wrote down. So the agent reads and protects first, and
changes code later.

### Phase 1. Read before changing

1. Write the real conventions into `AGENTS.md`: build and test commands, what
   each directory holds, and the areas not to touch.
2. Ask how the slice works, and why its odd parts exist. Answer mode edits
   nothing.

   ```text
   How does <subsystem> handle <what the ticket touches>? Then, why is
   <odd part> built this way? Cite the code and the history.
   ```

3. Make the package runnable and drivable with a `verify-<app>` skill.

### Phase 2. Pin the behavior

1. Before you change an area, add tests that pin what the code does now, right
   or wrong.
2. Use Simplify on the worst areas. It finds why odd code exists before it
   removes it, presents a plan, and keeps the tests green after each step.

### Phase 3. New work runs the full loop

A ticket goes through Design like a greenfield feature. The brief's "Now and
proposed" part matters most here, because tickets often describe how the code
used to work.

```text
Ticket: <paste it, or gh issue view 123>.
```

Run `/skill:blast-radius` on any diff you don't trust before it merges.

### Phase 4. Pay down

- `/skill:correct` turns a mistake that agents repeat into a type, a lint, or
  a test.
- `/skill:maintain-formal-verification-skill` rechecks a model after the code
  it describes changes.

## Review and merge

The agent opens one PR per package, as a stack. The root PR targets trunk, and
each child targets its parent. Each title states the outcome, and each body
shows evidence that I can trust without cloning the branch: media, pasted
output, or a CI link. The [`writing-good-prs`](../agent/skills/writing-good-prs/SKILL.md)
check rejects a body that only names a command to run.

For a PR that needs watching, say "babysit this". Review bots get a skeptical
triage, and each dismissal carries a reason.

## Anti-patterns

- **"Keep going until it's perfect."** That is not an end state, so the agent
  asks for one. Name a command, a test, or a capture that says done.
- **Agreeing to everything at once.** A brief holds at most five shape
  decisions. If you agree to all of them without reading, the design is the
  agent's, not yours.
- **Skipping the brief because the change is small.** State the change
  exactly instead, such as "rename X to Y", and the gate opens without a
  brief.
- **Long autonomous runs.** A run ends at its mode's end state. New scope
  starts a new request.
- **Merging on "tests pass".** A claim is not evidence. Read the before and
  the after in the PR.

## The two paths converge

Both paths end in the same loop: Design, Build one package, review the stack,
and merge. Greenfield starts there. Brownfield gets there after the read-only
and pinning phases give the agent a safe place to change code.

|                   | Greenfield                  | Brownfield                      |
| ----------------- | --------------------------- | ------------------------------- |
| First mode        | Design                      | Answer                          |
| First value       | A proven data model         | Cited answers and safer fixes   |
| Test posture      | Tests from the first commit | Tests where change is planned   |
| Refactoring rule  | Rare, little to refactor    | Pin the behavior first, always  |
| Riskiest shortcut | Skipping the state table    | Changing code that has no tests |
