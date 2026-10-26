---
name: reflect
description: Spawn three parallel review subagents over a session transcript, the active one by default, surface learnings, and route each to a concrete edit on a skill or on the project's agent environment. Use when the user says reflect or retro.
disable-model-invocation: true
user-invokable: true
---

# Reflect

Mine a session for durable learnings, then route each to one of two layers:

- **Harness**: a skill in the repository that holds this skill, which every project shares. Find it with `git -C <this skill's directory> rev-parse --show-toplevel`.
- **Project**: the agent environment of the repository the session worked in. That is its agent file (`AGENTS.md` or `CLAUDE.md`), its config record in `docs/agents/` (the standards record especially), its guardrails (lint rules, hooks, CI jobs), and its docs.

Invoke when the user says "reflect" or "retro". Skip when the conversation is trivial, off-topic, or already covered by an existing skill the parent followed correctly. One-offs are not learnings.

## 1. Locate the transcript

Default to this conversation's transcript, the Pi session file at `$PI_SESSION_FILE`. Pi leaves it unset for an ephemeral session. Then pass a tight digest of the session instead.

When the user names another session, find its file the way the **recall** skill describes, inside this workspace's session folder. Read another workspace's sessions only at a path the user gives. Do not glob across `~/.pi/agent/sessions/*/`: that reads private chats from unrelated projects.

## 2. Spawn three reviewers in parallel

Start three subagents together, per the **subagents** skill. Reviewers use MCP tools to look up the tickets, chat threads, and observability traces the transcript references.

The divergent reviewer takes the subagents skill's `reflect divergent` role.

| Lens | Prompt template |
|---|---|
| Judgment | `references/judgment-reviewer.md` |
| Tooling | `references/tooling-reviewer.md` |
| Divergent | `references/divergent-reviewer.md` |

Pass each template verbatim, substituting the transcript path or digest and the project's repository root where marked. Reviewers return findings in their final report.

## 3. Synthesize

One subagent. It spot-verifies citations through MCP. Pass `references/synthesizer.md` verbatim, with each reviewer's full output inlined where marked. It returns an Accepted / Rejected / Backlog list. Save it verbatim to `reflect/<YYYY-MM-DD>-<session-id>.md` in the state folder, so the proposal and the user's approval survive a compaction.

## 4. Structural enforcement check

Move any Accepted item that a lint rule, script, metadata flag, or runtime check would enforce more reliably to Backlog. See the **encode-lessons-in-structure** principle skill.

## 5. Propose, then wait

Present the synthesizer's Accepted / Rejected / Backlog output in one message, then end the turn. Show each Backlog item as a proposed ticket in three lines: its target repository (the harness repository for a harness item, the project repository for a project item), the problem it would track, and what the ticket would ask for. Ticket bodies come later, for approved items only.

The user picks the subset of each list, may redirect routings, and may reword a proposed ticket. Apply and file only what the user approves: skill changes reach every future agent, and tickets land in a tracker other people read. Record the approved subset in the state file.

## 6. Apply and file

Write and file each approved Backlog item under the **writing-good-tickets** skill, through the issue tracker record (`docs/agents/issue-tracker.md`) of its target repository.

Follow each approved Accepted row's Routing exactly:

- Trivial existing-skill edit (a one-line bullet, a tightened sentence, a stale fact corrected): the parent does it directly.
- Substantive existing-skill edit (a new section, a new pattern table, more than ~10 lines): write it under the **writing-for-agents** skill.
- `tune description: <skill path>` (the skill exists but didn't trigger when it should have): rewrite the description per the Context pointers section of the **writing-for-agents** skill.
- `new skill via writing-for-agents: <kebab-name>`: create it under the **writing-for-agents** skill. Do not invent the shape ad hoc.
- `project: <path + section>`: edit that file in the project repository under the **writing-for-agents** skill. The agent file carries navigation pointers only. A judgement-call standard goes to the standards record, which reviewers read, rather than to the agent file, which the implementing agent carries.

If your environment ships a SKILL.md validator, run it on every touched skill before declaring done.

## 7. Summarize for the user

Short list, no preamble:

- Edits applied: `<skill path>`. What changed, one line each.
- New skills created: `<skill path>`. One line each (rare).
- Backlog filed: `<issue title>` in `<repository>`. One line each.
- Dropped: one line per rejected finding + reason from the synthesizer.
