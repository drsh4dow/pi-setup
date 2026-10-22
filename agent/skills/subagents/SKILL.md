---
name: subagents
description: Read before using subagents.
user-invokable: false
---

# Subagents

A subagent is a separate Pi process, started with `pi-subagent`, with the
normal prompt, skills, and tools. It receives one assignment and returns one
report.

## Kinds

Every subagent is a delegate, except one you hand a whole unit, such as a PR,
which is an owner. The launch names the kind, and the `delegate-guard`
extension blocks any spawn the kind does not allow.

- **Delegate.** Does one piece of its parent's task: code for a written scope,
  an exploration, or a review. It is a leaf. Its parent owns the task, the
  review of its output, and every spawn.
- **Owner.** Carries one whole unit the way a top-level session would, and
  launches each of its workers and verifiers as a delegate. An owner is a
  background terminal of its parent, so it ends with its parent, and its
  children are absent from the parent's `bg_list`.

## Models

| Work | Model | Thinking |
| --- | --- | --- |
| Exploration and search | `anthropic/claude-haiku-5-5` | `medium` |
| Code, review, and judgment | `anthropic/claude-opus-5-5` | `high` |
| Second-opinion review of work Opus wrote | `openai/gpt-6.1-sol` | `high` |

`high` is the ceiling for every model. Lower Opus to `medium` or `low` for
routine work. When a Haiku report fails a spot check, such as a wrong
reference or a missed file, rerun that slice on Opus at `medium`. If a model
fails to launch, rerun that seat on `anthropic/claude-opus-5-5` at `high` and
say so in your report.

## Prepare

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

For changes, read the diff and run the repository's verification yourself: the
report states what the child intended, and the diff shows what it did. For
findings, check consequential claims against their cited sources.
