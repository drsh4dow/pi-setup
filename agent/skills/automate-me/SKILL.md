---
name: automate-me
description: Use for personal mode authoring from the user's working preferences.
disable-model-invocation: false
user-invokable: false
---

# Automate me

Turn the user's working conventions into one concise `-mode` skill. Use direct answers as the primary source. Mine Pi sessions only when the user explicitly requests transcript-based evidence.

## 1. Set the scope

Find existing mode skills under `agent/skills/**/*-mode/SKILL.md`. Match the user's stated handle or identifier rather than guessing from unrelated files.

If a matching skill exists, use update mode when the request says update, refresh, or improve. Otherwise confirm whether to update it or start fresh. In update mode, preserve rules the user has not contradicted and ask what is missing or stale.

Confirm these choices when the request does not already settle them:

- the handle and destination under `agent/skills/`
- whether transcript mining is allowed
- the exact workspace and time range allowed for mining
- whether the mode should load automatically or only when explicitly named

A request to capture preferences does not by itself authorize reading past sessions. The scope is complete when every source and destination is user-approved.

## 2. Gather evidence

Ask one or two compact multiple-choice questions about the areas that matter, followed by one open question. Cover only selected areas. Useful branches include response style, autonomy, delegation, verification, code and prose rules, process, and skill maintenance.

When the user requested transcript mining, map the approved workspace to its single directory under `agent/sessions/`. Read only JSONL files in that directory and only within the approved time range. Never search sibling workspace directories, credentials, tool payload secrets, or unrelated personal content. Extract preference-bearing user statements and the assistant behavior they corrected. Summarize patterns without copying sensitive transcript text into the skill.

For a small history, inspect it directly. For enough history to benefit from partitioning, split the approved time range into at most three non-overlapping slices and use bounded read-only delegates. Give each delegate the exact directory, date bounds, signal categories, and a compact output contract. Treat delegate reports as leads and inspect their cited session records before accepting a pattern.

In update mode, mine only sessions after the existing skill's last modification time unless the user approved a wider range. A mined rule needs support in at least two separate sessions. Keep a single-session statement only when the user confirms it directly. Prefer newer explicit corrections when evidence conflicts.

Evidence gathering is complete when each candidate rule has direct user confirmation or pointers to two inspected sessions, and sensitive content has been discarded from the working summary.

## 3. Shape the mode

Cluster accepted rules by the user's actual concerns. Possible sections include response style, autonomy, understanding, delegation, code and prose, review and verification, process, and skills. Omit sections with no specific non-default rule.

Write operational instructions that change agent behavior. Use "the user" rather than a name inside the body. Point to existing skills or project documents instead of copying their rules. Remove generic advice, repeated meanings, inferred personality claims, and conventions that belong in a task-specific skill.

For an update, revise contradicted rules in place and add only genuinely new behavior. Keep the existing structure when it still fits.

## 4. Author and review

Before drafting, read `agent/skills/writing-for-agents/SKILL.md`, its `SKILL-MECHANICS.md`, and `agent/skills/unslop/SKILL.md`. Follow their current frontmatter, invocation, pointer, completion, pruning, and prose rules rather than caching them here.

Use `<handle>-mode` as the skill name and `agent/skills/<handle>-mode/SKILL.md` as the default destination. Preserve an established personal category only when one already exists. Write a short description with distinct real trigger branches. Set invocation fields from the choice made in step 1, using the repository's current skill mechanics.

Show the draft and the evidence-to-rule summary to the user. Cite session filenames and timestamps, not transcript excerpts. Revise until the user says the mode reflects how they work. Then write or update only the approved local skill files and re-read the final result.

## Boundaries

- Keep transcript access workspace-scoped, time-bounded, and explicitly requested.
- Keep private details out of the mode skill, reports, commit messages, and external systems.
- Local authoring does not authorize commits, pushes, issues, pull requests, merges, or other external writes. Perform any such action only after separate explicit approval.
- A personal mode captures broad working conventions. Route a task-specific capability to skill authoring without transcript mining. Route one narrow convention, such as commit-message format, to a regular skill.
- Do not overfit, force balanced sections, or turn the mode into a manual. Sparse output is valid.
