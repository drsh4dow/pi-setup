---
name: subagents
description: Read before using subagents.
disable-model-invocation: false
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

Each subagent runs the model and thinking level of its role. Skills and
playbooks name the role, such as "the `how explorer` role".

The families differ in strength. `openai/gpt-6.1-sol` is exhaustive on
details and edge cases: boundaries, proofs, exploits, spec gaps. Opus has
taste: it writes, plans, and implements best, and judges whether code reads
well and has the simplest shape. Give a new role the family whose strength the
job needs.

| Role | Model | Thinking |
| --- | --- | --- |
| `how explorer`, `why investigators`, `swarm scouts` | `anthropic/claude-haiku-5-5` | `medium` |
| `hardest tasks` | `anthropic/claude-opus-5-5` | `high` |
| `feature, refactoring`, `bug-fix`, `perf-issue`, `hillclimb` | `anthropic/claude-opus-5-5` | `medium` |
| `judgment and prose` | `anthropic/claude-opus-5-5` | `high` |
| `how explainer`, `why synthesizer` | `anthropic/claude-opus-5-5` | `high` |
| `reflect judgment, synthesizer` | `anthropic/claude-opus-5-5` | `high` |
| `reflect divergent` | `openai/gpt-6.1-sol` | `high` |
| `reflect tooling` | `anthropic/claude-opus-5-5` | `medium` |
| `researcher` | `openai/gpt-6.1-sol` | `high` |
| `swarm workers` | `anthropic/claude-opus-5-5` | `high` |
| `arena runners`, `architect runners`, `architect reviewers` | `anthropic/claude-opus-5-5`, `openai/gpt-6.1-sol` | `high` |
| `arena cross-judge pool` | `anthropic/claude-opus-5-5`, `openai/gpt-6.1-sol` | `high` |
| `cross-family reviewer` | `openai/gpt-6.1-sol` | `high` |
| `code-review detail personas` | `openai/gpt-6.1-sol` | `high` |
| `code-review taste personas` | `anthropic/claude-opus-5-5` | `high` |

A role with two models is a panel: run one subagent per model, so the panel
size equals the number of models. Panels mix model families because their
value is independent judgment. From the cross-judge pool, pick one model whose
family differs from the candidates being judged, when possible.

A reviewer or verifier that must run on a different model family from the
work's author takes the `cross-family reviewer` role. When the author ran on
`openai/gpt-6.1-sol`, run it on `anthropic/claude-opus-5-5` at `high` instead.

Before each spawn, start from the role's row and pick the thinking level the
job needs. Raise it one step for the hardest or subtlest work. Lower it one
step for judgment and two or more steps for routine work. Change only the
thinking level and keep the model the role names, so a panel stays diverse.
`high` is the ceiling for every model. Haiku runs at `medium`.
Opus stays between `low` and `high`. When a Haiku report fails a spot
check, such as a wrong reference or a missed file, rerun that slice on Opus at
`medium`. If a model fails to launch, rerun that seat on
`anthropic/claude-opus-5-5` at `high` and say so in your report.

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

## Use the report

Read an owner's todolist before its diff, and send back a skipped step its
playbook marks mandatory. For changes, read the diff and run the repository's verification yourself: the
report states what the child intended, and the diff shows what it did. For
findings, check consequential claims against their cited sources.
