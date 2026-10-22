---
name: writing-good-commits
description: Write or reword a git commit message and size the commit it describes. Use when committing, or when reshaping commits during a rebase.
disable-model-invocation: false
user-invokable: false
---

# Writing good commits

A commit message is what a maintainer reads in `git log`, `git blame`, and `git bisect` months later, with no PR or chat beside it. The subject names the change. The body says why the change was needed.

Edit the prose with the **unslop** skill.

## Size

- Put one logical change in each commit. A change across many files is still one commit, and two changes in one file are two commits.
- Make every commit build and pass the checks, so `git bisect` can stop on any of them. Check a series with `git rebase -x '<check>' <base>`.
- Move or rename code in its own commit, with no edits mixed in.
- Split a commit whose message you cannot summarize in one subject.

## Subject

Use Conventional Commits, `type(scope): subject`.

- The type is one of `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `revert`, or `style`. A commit that fits two types is two commits.
- The scope is a noun for the area, such as `subagents` or `web`. Reuse the scopes in `git log --no-merges --format=%s -- <files>`.
- Write the subject in the imperative, so it completes "If applied, this commit will …". Start it lowercase unless it starts with an identifier or a proper noun, and end it without a period.
- Aim for 50 characters, and keep the whole header within 72.
- Say what changes, uniquely within the series. A bare file name or "address feedback" says nothing in `git log --oneline`.
- Mark a breaking change with `!` before the colon, such as `feat(api)!: drop the v1 routes`.

## Body

Leave the body out when the subject says it all. Otherwise, after one blank line, wrap at 72 columns and cover:

- The problem, in the present tense: what the code does without this change.
- Why this approach, and the rejected alternatives a reader would ask about.
- The impact a user sees. Back a performance claim with a `before → after` number.

Leave the how to the diff. Make the message self-contained: summarize a discussion rather than only linking it, and cite another commit as `abc1234 ("subject")`. Keep the process out: the commands you ran, review rounds, and "v2" notes belong in the PR.

## Trailers

End with one trailer block after a blank line, one `Token: value` per line. Use only these:

- `BREAKING CHANGE: <what breaks and how to migrate>`, alongside the `!` in the header.
- `Closes #N` for an issue the commit resolves.
- `Refs: #N` for a related issue or commit it does not resolve.

## Example

```text
fix(subagents): kill the child tree when the launcher exits

A SIGKILL to the launcher leaves grandchildren running, because
cleanup runs only on SIGTERM. Put each run in its own process group
and kill the group from the parent's exit hook. A pidfile sweep was
rejected because it races with PID reuse.

Closes #142
```

The same change written badly:

```text
Fixed stuff in subagents and also updated docs.

Changed launcher.ts to call process.kill. Updated README. Ran tests.
```

It has no type or scope, uses the past tense, ends in a period, mixes two changes, restates the diff and the process, and never says why.
