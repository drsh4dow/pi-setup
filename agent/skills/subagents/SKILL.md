---
name: subagents
description: Read before using subagents.
---

# Subagents

A subagent is a separate `pi --print` process with the normal prompt, skills,
and tools. It receives one assignment and returns one report.

Pick the model by the work:

- `anthropic/claude-opus-5-5`: implementation, design, art, and work that
  depends on taste.
- `openai-codex/gpt-6.1-sol`: research, scouting, code review, audits, and
  scraping.

## Prepare

Read and apply [writing-for-agents](../writing-for-agents/SKILL.md).

Write one self-contained assignment per subagent; the child sees none of this
conversation. An assignment is ready when it states:

- The task, with the context and source leads it needs.
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

Use the session name as the terminal title. Pick a heredoc delimiter that does
not occur as a standalone line in the assignment.

## Use the report

For changes, read the diff and run the repository's verification yourself: the
report states what the child intended, and the diff shows what it did. For
findings, check consequential claims against their cited sources.
