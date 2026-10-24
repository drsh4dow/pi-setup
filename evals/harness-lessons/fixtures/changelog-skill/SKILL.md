---
name: changelog
description: Write the changelog entry for a pull request. Use when a PR changes behavior that users, operators, or integrators can notice.
---

<!-- Upstream: github.com/acme/agent-skills @ 3f9c2e1 (synced 2026-09-14) -->

# Changelog entries

When a pull request changes something a user can notice, it needs an entry under
`## Unreleased` in `CHANGELOG.md` before it merges.

## Steps

1. Read the diff and the PR description, and decide which section the change belongs to:
   Added, Changed, Deprecated, Removed, Fixed, or Security.
2. Apply the `needs-changelog` label to the PR so the release captain can find it.
3. Save drafts to ~/notes/acme/changelog/ until the entry is final, then move the text into
   `CHANGELOG.md`.
4. Write the entry by the rules below and commit it with the change.

## Rules

- Write each entry for the person upgrading, not for the person who wrote the code.
- Start with the verb that says what happened: Added, Changed, Fixed, Removed.
- The reviewer, not the author, decides whether an entry is user-facing.
- When a change breaks existing behavior, say what the reader must do before they upgrade.
- Link the pull request at the end of the entry, never in the middle of the sentence.
