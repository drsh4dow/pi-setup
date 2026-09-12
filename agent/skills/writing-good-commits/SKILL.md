---
name: writing-good-commits
description: Use when drafting or revising a Git commit message, including a squash commit message.
user-invokable: false
---

# Writing good commits

Write a message that lets a maintainer understand the change while scanning `git log`.

## Establish the change

Use the supplied diff or inspect the intended commit's changes. For a staged commit, describe only the staged changes; for a squash commit, describe the combined result.

Follow explicit repository commit conventions. Otherwise, default to `type(scope): summary`, omitting the scope when no single area fits.

## Write the message

Default to one subject line with a direct verb and a concrete change. Name the affected behavior or mechanism. Include the condition when it distinguishes the change: when pinning threads, while streaming, or across server restarts.

Prefer familiar words and recognizable subsystem names. Keep technical identifiers when they add precision. Describe refactors and maintenance directly without inventing a user-visible benefit.

Keep the subject easy to scan. Remove filler before removing useful meaning; follow repository length limits when present.

Add a short body only for consequential rationale, constraints, or compatibility details the subject cannot carry. Explain what would otherwise be lost, rather than listing files or narrating the diff. Preserve required references and trailers.

Ground every claim in the changes and known context. Describe the result of follow-up work rather than the review process.

## Examples

Subjects from [t3code](https://github.com/pingdotgg/t3code), with merge-added PR numbers omitted:

- `fix(desktop): keep preview keystrokes out of the composer`
- `perf(web): format minimap previews only when opened`
- `refactor(desktop): share preview keyboard targeting and packet generation`

## Output

When asked for a message, return the message alone, without a preamble, Markdown wrapper, or alternatives unless requested. Drafting a message does not authorize staging, committing, or rewriting history.

Before returning it, check: could this subject describe many unrelated changes? If so, replace vague wording with the specific change.
