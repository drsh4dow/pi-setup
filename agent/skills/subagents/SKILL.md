---
name: subagents
description: Read before using subagents.
---

# Subagents

A subagent is a separate `pi --print` process with the normal prompt, skills,
and tools. It receives one assignment and returns one report.

## Kinds

Every subagent is an owner or a delegate. The assignment names which, and the
launch follows from it.

- **Owner.** Receives a whole unit, such as a PR, a plan step, or a queue item,
  and runs it the way a top-level session would. It matches the playbook, keeps
  the todolist, and spawns the delegates its playbook names. Spawn an owner only
  where a playbook hands a unit to one: Feature's single owner for code-coupled
  work, the owners in Multi-phase plan, Autopilot-full, and Autopilot-stack, and
  Orchestrate's sub-coordinators.
- **Delegate.** Does one piece of its parent's step: code for a written scope,
  an exploration, a review, a swarm lane, an arena or architect candidate, or
  Comment Sicko. It is a leaf. Its parent owns the playbook, the todolist, the
  review of its output, and every spawn.

## Models

Each subagent runs the model and thinking level of its role. Skills and
playbooks name the role, such as "the `how explorer` role".

| Role | Model | Thinking |
| --- | --- | --- |
| `how explorer`, `why investigators`, `swarm scouts` | `anthropic/claude-haiku-5-5` | `medium` |
| `hardest tasks`, `feature, refactoring`, `bug-fix`, `perf-issue`, `hillclimb` | `anthropic/claude-opus-5-5` | `high` |
| `judgment and prose` | `anthropic/claude-opus-5-5` | `high` |
| `how explainer`, `why synthesizer` | `anthropic/claude-opus-5-5` | `high` |
| `reflect judgment, synthesizer` | `anthropic/claude-opus-5-5` | `high` |
| `reflect divergent` | `openai/gpt-6.1-sol` | `high` |
| `reflect tooling` | `anthropic/claude-opus-5-5` | `medium` |
| `swarm workers` | `anthropic/claude-opus-5-5` | `high` |
| `arena runners`, `architect runners`, `interrogate reviewers` | `anthropic/claude-opus-5-5`, `openai/gpt-6.1-sol` | `high` |
| `arena cross-judge pool` | `anthropic/claude-opus-5-5`, `openai/gpt-6.1-sol` | `high` |

A role with two models is a panel: run one subagent per model, so the panel
size equals the number of models. Panels mix model families because their
value is independent judgment. From the cross-judge pool, pick one model whose
family differs from the candidates being judged, when possible.

The hardest changes, such as cross-cutting design, concurrency, or subtle
algorithms, take the `hardest tasks` role. `high` is the thinking ceiling for
every model. Haiku runs at `medium`. Opus stays between `medium` and `high`.
Lower a `high` Opus role to `medium` for routine, precisely specified work such
as mechanical renames, applying a written diff, or one edit repeated across
files. Keep the role's model so a
panel stays diverse. When a Haiku report fails a spot check, such as a wrong
reference or a missed file, rerun that slice on Opus at `medium`. If a model
fails to launch, rerun that seat on `anthropic/claude-opus-5-5` at `high` and
say so in your report.

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

Subagents share the worktree, and a write scope is an instruction rather than a
sandbox. Give concurrent writers disjoint files, counting the generated files
and caches their verification writes, or run them in sequence.

## Launch

Read [background-terminals](../background-terminals/SKILL.md), then start each
subagent with `bg_start` in the project directory:

```bash
pi --print \
  --model <model> \
  --thinking high \
  --append-system-prompt "$HOME/.pi/agent/skills/subagents/unattended.md" \
  --append-system-prompt "$HOME/.pi/agent/skills/subagents/delegate.md" \
  --name "subagent: <short assignment>" <<'SUBAGENT_PROMPT'
<assignment>
SUBAGENT_PROMPT
```

An owner launch drops the `delegate.md` line. Use the session name as the
terminal title. Keep the `subagent:` prefix: the
fast-mode extension reads it to apply each provider's `subagentsEnabled`
setting. Pick a heredoc delimiter that does not occur as a standalone line in
the assignment.

## Use the report

Read an owner's todolist before its diff, and send back a skipped step its
playbook marks mandatory. For changes, read the diff and run the repository's verification yourself: the
report states what the child intended, and the diff shows what it did. For
findings, check consequential claims against their cited sources.
