---
name: subagents
description: Read before using subagents.
---

# Subagents

A subagent is a separate `pi --print` process with the normal prompt, skills,
and tools. It receives one assignment and returns one report.

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
  --name "subagent: <short assignment>" <<'SUBAGENT_PROMPT'
<assignment>
SUBAGENT_PROMPT
```

Use the session name as the terminal title. Keep the `subagent:` prefix: the
fast-mode extension reads it to apply each provider's `subagentsEnabled`
setting. Pick a heredoc delimiter that does not occur as a standalone line in
the assignment.

## Use the report

For changes, read the diff and run the repository's verification yourself: the
report states what the child intended, and the diff shows what it did. For
findings, check consequential claims against their cited sources.
