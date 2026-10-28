---
name: subagents
description: Read before using subagents.
disable-model-invocation: true
user-invokable: false
---

# Subagents

A subagent is a separate Pi process, started with `pi-subagent`, with the
normal prompt, skills, and tools. It receives one assignment and returns one
report.

## Kinds

Every subagent is a delegate, except one a playbook hands a whole unit, which
is an owner. The launch names the kind, and the `delegate-guard` extension
blocks any spawn the kind does not allow.

- **Delegate.** Does one piece of its parent's step: code for a written scope,
  an exploration, a review, a swarm lane, an arena or architect candidate, or
  Comment Sicko. It is a leaf. Its parent owns the playbook, the todolist, the
  review of its output, and every spawn.
- **Owner.** Carries one unit a playbook hands it: a PR under Autopilot-full,
  Autopilot-stack, or a multi-phase plan, code-coupled Feature work, a Visual
  parity component, or an Orchestrate track. It runs its unit the way a
  top-level session would, keeps the todolist, and launches each of its
  workers and verifiers as a delegate. An owner is a background terminal of
  its parent, so it ends with its parent, and its children are absent from the
  parent's `bg_list`. Record each owner's children in the agent store so the
  root can probe them.

## Models

Every subagent runs at `--thinking high`, on the model of the role a skill or
playbook names.

- `openai/gpt-6.1-sol` is exhaustive on details and edge cases: boundaries,
  proofs, exploits, spec gaps. It runs `cross-family reviewer`,
  `code-review detail personas`, `reflect divergent`, and `researcher`.
- `anthropic/claude-opus-5-5` has taste: it writes, plans, and implements
  best, and judges whether code reads well and has the simplest shape. It runs
  every other role.
- A panel runs one subagent per model, for independent judgment:
  `arena runners`, `architect runners`, and `architect reviewers`. The
  `arena cross-judge pool` seats one judge, on the model the candidates did
  not use when possible.

A new role takes the model whose strength the job needs. A reviewer or verifier
that must differ in family from the work's author takes the
`cross-family reviewer` role, on the model the author did not use.

## Prepare

Read and apply [writing-for-agents](../writing-for-agents/SKILL.md).

Write one self-contained assignment per subagent; the child sees none of this
conversation. An assignment is ready when it states:

- The kind, owner or delegate.
- The task, with the context and source leads it needs.
- The skills the work requires, by name.
- The write scope: the files the child owns, or that it changes nothing.
- A done condition the child can check.
- The report: changes made, findings with references, judgment calls, and open
  questions, sized to the user's request.

Subagents share the worktree and the host, and a write scope is an instruction
rather than a sandbox. Give concurrent children disjoint files, counting the
generated files and caches their verification writes, or run them in sequence.
The same holds beyond files: give each its own scratch directories,
containers, and toolchain installs, keep setup commands such as installs and
checkout syncs inside its own tree, and limit its cleanup to what it created.
Worktrees of one repository share its stash, refs, and worktree metadata, so a
child saves work in progress as a commit on its own branch, never with
`git stash`, and a child that must not write the main checkout works in a
separate clone instead of a worktree.
Before accepting a comparison, such as a before and after, check that no
sibling wrote the state it measured.

## Launch

Read [background-terminals](../background-terminals/SKILL.md), then start each
subagent with `bg_start` in the project directory. Project MCP servers bind to
the launch directory, so a child launched elsewhere, such as `/tmp`, has no
tracker or observability tools:

```bash
pi-subagent \
  --model <model> \
  --thinking high \
  --append-system-prompt "$HOME/.pi/agent/skills/subagents/unattended.md" \
  --append-system-prompt "$HOME/.pi/agent/skills/subagents/delegate.md" \
  --name "subagent: <short assignment>" <<'SUBAGENT_PROMPT'
<assignment>
SUBAGENT_PROMPT
```

`pi-subagent` takes the arguments of `pi --print`. Inside herdr, the child
runs as a read-only Pi chat in a pane of the parent's workspace. Outside
herdr, it runs `pi --print`. Either way, the launch prints the child's report
on stdout and exits 0 on success, as `pi --print` does.

An owner launch appends `owner.md` in place of `delegate.md`. A launch
without `owner.md` is a delegate. Use the session name as the
terminal title. Keep the `subagent:` prefix: the
fast-mode extension reads it to apply each provider's `subagentsEnabled`
setting. Pick a heredoc delimiter that does not occur as a standalone line in
the assignment.

## Launch from a brief

A playbook that writes each assignment to a file, such as implement-chunk's
briefs or code-review's persona assignments, launches it with
[`scripts/launch.ts`](scripts/launch.ts) instead of the raw block above, in a
`bg_start` command in the project directory:

```bash
$HOME/.pi/agent/skills/subagents/scripts/launch.ts \
  --kind <delegate|owner> \
  --role <role> \
  --brief "<state folder>/<brief>.md" \
  --orders "<state folder>/orders.md" \
  --model <model> \
  --thinking high \
  --name "subagent: <short assignment>"
```

The launcher appends `unattended.md`, the kind's file, a heading that names
the orders file, the orders file, and each `--append <file>` to the system
prompt, and pipes the brief to `pi-subagent` as the prompt. Pi reads the appends when
the child starts, so every spawn and resume carries the orders as they stand.
Pass `--orders none` only when no standing-orders file exists.

Before it starts Pi, it refuses with exit 2 and a `launch: refused:` line
naming the cause:

- a brief, orders file, or append that is missing or empty;
- a brief that lacks a field its `--role` requires. The implement-chunk roles
  need every template field (a merger needs STEPS in place of VERIFY), and a
  brief whose first line starts with `COLLAPSED` needs only GOAL, SCOPE,
  VERIFY, and REPORT named in its paragraph. `persona` and `assignment` need
  no fields;
- a KIND field that disagrees with `--kind`;
- a placeholder outside fenced code, such as `undefined`, `NaN`,
  `[object Object]`, `origin/origin/`, `${…}`, or `<sha>`, printed with its
  line;
- an input branch that the launch directory's `origin` lacks: each
  `origin/<name>`, and the branch SCOPE names after "based on". Write a branch
  the unit creates without `origin/`.

While the one-minute load exceeds `--max-load` (default `nproc`) or
`MemAvailable` is below `--min-mem-gib` (default 4), it holds and prints both
with their limits every `--poll-seconds`.

The child's report is the launcher's stdout. Exit 0 means the child reported,
and 1 means it failed. Stderr names the session id. To resume the child, run
the same command with `--resume <session id>` and a brief file holding the new
directive, which needs no template fields. Pi sends a resumed child's current
orders as a system update after the earlier text, so the launcher opens the
directive with a note that the update is current. `--dry-run` runs every check, then
prints the command, the content of every append with the orders' line count,
and the prompt, and starts no Pi.

## Retry

Retry a failed child by how it failed:

- Cap hit, or out of memory on an idle host: respawn with a smaller scope.
- Out of memory on a loaded host: respawn as-is once the host has headroom,
  which the brief launcher waits for.
- Network drop: retry as-is.
- Launch failure or tool error: retry once, then rerun on the other model, and
  report each cross-family or panel seat that lost its independence.
- Unknown: retry once.

## Use the report

Read an owner's todolist before its diff, and send back a skipped step its
playbook marks mandatory. For changes, read the diff and run the repository's verification yourself: the
report states what the child intended, and the diff shows what it did. For
findings, check consequential claims against their cited sources.
