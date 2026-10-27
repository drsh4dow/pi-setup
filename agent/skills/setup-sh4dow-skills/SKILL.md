---
name: setup-sh4dow-skills
description: "Set up a repository for the engineering skills: its issue tracker, domain docs and base glossary, and coding standards with guardrail commands. Run once per repository, and again when any of them changes."
disable-model-invocation: true
user-invokable: true
---

# Setup sh4dow skills

Write the per-repository **config record** the engineering skills read instead of guessing:

| File | Records | Read by |
| --- | --- | --- |
| `docs/agents/issue-tracker.md` | Where issues live and how to create, read, search, edit, comment on, nest, block, and close them | **to-spec**, **to-tickets**, **triage**, **code-review**, **writing-good-tickets**, **reflect** |
| `docs/agents/domain.md` | The glossary and ADR layout, and how to use them | **domain-modeling**, **grill-with-docs**, **improve-codebase-architecture**, **to-spec**, **to-tickets** |
| `docs/agents/standards.md` | Where the coding standards live, and the guardrail commands that check the code | **code-review**, **reflect** |
| `GLOSSARY.md` | The project's core domain terms | every skill that names a domain concept |

The record is committed, so every agent and collaborator in the repository reads the same facts. An `## Agent skills` block in the repository's agent file points at it.

The run is idempotent. A second run on an unchanged repository asks nothing and writes nothing.

## 1. Explore

Finding facts is your job. Read what exists and assume nothing:

- **Prior record.** `docs/agents/*.md` and the `## Agent skills` block. When they exist, this is a rerun: compare each recorded fact to what you find now.
- **Agent file.** `CLAUDE.md` and `AGENTS.md` at the repository root.
- **Tracker.** `git remote -v`. Whether `gh auth status` or `glab auth status` succeeds. Which MCP servers declared to you reach a tracker, such as Linear, Jira, or Notion. Any tracker the README or agent file names.
- **Domain docs.** `GLOSSARY.md`, `GLOSSARY-MAP.md`, `docs/adr/`, and `*/docs/adr/`. Monorepo signals: a `pnpm-workspace.yaml`, a `workspaces` field, `go.work`, a Cargo workspace, or several `packages/*` with their own sources.
- **Standards.** `CODING_STANDARDS.md`, `CONTRIBUTING.md`, style guides, `.editorconfig`, and linter and formatter configs.
- **Guardrails.** The format, lint, typecheck, and test commands, from `package.json` scripts, `Makefile`, `justfile`, `Taskfile.yml`, `pyproject.toml`, `Cargo.toml`, or `go.mod`. The CI workflows that run them. Pre-commit hooks (`.husky/`, `.pre-commit-config.yaml`, `lefthook.yml`).
- **Code.** Whether the repository has source code yet. Without it, the repository is greenfield.

Run each lint and typecheck command once. A command that fails, or a repository whose CI and hooks run no guardrail at all, is a finding to report in section C.

Exploration is done when every bullet above has an answer, "none" included.

## 2. Ask, one section at a time

Summarize what you found, then take the sections in order, per the **grilling** skill: one section, one answer, then the next. Lead with the recommended answer, worded so "yes" accepts it. Skip a section when exploration settled it, or when the prior record still matches what you found, and say it is unchanged.

**A. Issue tracker.** Recommend the tracker the remote, the README, or the agent file names, else one an MCP server declared to you reaches. A CLI that is not authenticated, or a project you cannot reach, does not change the recommendation: record that tracker and report the access failure as a finding. Recommend local Markdown only when nothing names a tracker.

- **GitHub**, through `gh`. Template: [issue-tracker-github.md](issue-tracker-github.md).
- **GitLab**, through `glab`. Template: [issue-tracker-gitlab.md](issue-tracker-gitlab.md).
- **Local Markdown** in the state folder, for a repository with no tracker. Template: [issue-tracker-local.md](issue-tracker-local.md).
- **Other**, such as Linear, Jira, or Notion. Template: [issue-tracker-other.md](issue-tracker-other.md). Fill each operation with the exact MCP tool or CLI command that performs it, found by listing the server's tools, and ask the user only for what the tools cannot tell you, such as the team or project to file into.

**B. Domain docs and base glossary.** Write the single-context layout without asking, unless exploration found monorepo signals. Then offer multi-context.

For the base glossary, a brownfield repository seeds it from the code. Run a subagent per the **subagents** skill to propose five to fifteen candidate terms, each with the code that uses it. A greenfield repository seeds it from the user: ask for the core nouns of the domain, or skip the glossary until the first term is settled. Resolve each term with the user per the **domain-modeling** skill and write it in that skill's glossary format. Leave `docs/adr/` until the first decision needs recording. Template: [domain.md](domain.md).

**C. Standards and guardrails.** Show the standards sources and guardrail commands you found, each with where you found it, and every failing or missing guardrail. Offer to record them as found. Adding a missing guardrail is separate work: record it as a finding in the file rather than building it here. Template: [standards.md](standards.md).

## 3. Confirm

Pick the agent file first: `CLAUDE.md` when it exists, else `AGENTS.md`. When neither exists, ask which to create. Never create one beside the other. When the agent file already has a section that records the tracker or the standards in its own words, the drafts fold its facts into the record and replace the section with the block, so each fact lives in one place.

Show the user a draft of every file you will write or change, and of the `## Agent skills` block. Let them edit before anything is written.

## 4. Write

The record has no triage labels, and setup creates no labels in the tracker.

Write the `## Agent skills` block into the agent file, or update it in place when it exists, leaving the rest of the file untouched:

```markdown
## Agent skills

The engineering skills read this repository's config record in `docs/agents/`.
Rerun the **setup-sh4dow-skills** skill when the tracker, the domain layout, or the
guardrails change.

- Issue tracker: [one-line summary]. See `docs/agents/issue-tracker.md`.
- Domain docs: [single-context or multi-context]. See `docs/agents/domain.md`.
- Standards: [one-line summary]. See `docs/agents/standards.md`.
```

Write each `docs/agents/` file from its template, and write `GLOSSARY.md` when terms were settled.

Commit only the files this run wrote, in one commit, per the **writing-good-commits** skill.

## 5. Report

List each file written or left unchanged, and every finding from section C. Name the skills that now read the record.
