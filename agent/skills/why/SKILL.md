---
name: why
description: "Use for 'why does X work this way', 'why we picked Y', design rationale, regressions, postmortems, or data-backed thresholds. Investigates available historical sources, parallelizes independent queries, and returns cited findings with explicit confidence and coverage gaps. Use how for runtime behavior."
disable-model-invocation: false
---

# Why

Investigate what motivated the code's shape. `how` explains runtime behavior; `why` explains the decisions and constraints behind it.

Read [epistemics.md](references/epistemics.md) before investigating. Separate evidence from inference throughout. Treat a hypothesis embedded in the user's question as a candidate to test, not a conclusion.

Keep source investigation read-only. Do not edit repository files, commit, or modify external state.

## 1. Anchor the question in code

Identify the target files, line ranges, and key symbols. If the target is vague, state your interpretation so the user can redirect, then proceed.

Find the commits touching the target and the linked PRs and tickets:

```bash
git blame -L <start>,<end> <file>
git log --oneline -20 -- <file>
git log -1 --format=%B <commit>
gh pr view <number> --json title,body,author,createdAt,mergedAt,labels,closingIssuesReferences,comments,reviews
```

Read substantive patches and PR discussions. Use `git log --follow` to trace history through renames. Follow the history back to the relevant decision rather than assuming the last edit explains it.

Keep the paths, symbols, commits, PR numbers, and ticket IDs as search anchors.

## 2. Map available evidence

Discover available MCP servers and tools through the MCP gateway. Inspect server instructions and tool schemas before using examples from the [source playbooks](references/source-playbook.md). Use available CLI and repository sources too; a missing MCP does not rule out a category.

Account for all seven categories:

| Category | Evidence to seek |
|---|---|
| Source control | Commit history, PR discussions, comments, and tests recording implementation-time rationale. Start with local git and use `gh` for hosted history when available. |
| Issue / ticket tracker | Product needs, customer requests, business constraints, and scope changes. |
| Long-form documents | Design rationale, alternatives, ADRs, and postmortems. Include relevant repository documents. |
| Real-time team chat | Deliberation and incident discussions missing from formal records. |
| Infrastructure observability | Runtime conditions motivating timeouts, retries, limits, and other operational decisions. |
| Error / exception tracking | Specific failures and their history around corrective changes. |
| Product analytics warehouse | Usage, experiments, migrations, and measurements behind thresholds. |

Search every available category unless it is demonstrably irrelevant. Record an explicit reason for each skip in the final coverage report. Unavailable tools, denied access, and expired retention are coverage gaps, not empty search results.

A narrow question with an explicit answer in its PR may need no further searches only after checking that the remaining categories would be redundant. State that justification rather than silently reducing coverage.

## 3. Gather evidence directly

Load the playbook for each category as you reach it. For defensive code such as retries, timeout handling, rate limits, or guards, also read [incident-postmortem.md](references/sources/incident-postmortem.md).

Parallelize independent searches and fetches. Follow dependent leads after their results arrive. Keep query results bounded and retain precise citations rather than raw payloads.

For each category:

1. Search broadly using the code anchors, feature names, authors, and relevant dates, then narrow to promising records.
2. Read relevant PRs, tickets, documents, and threads fully, including comments. Titles and previews are not enough.
3. Follow relevant links across sources yourself. Track records already inspected to avoid duplicate work. Record inaccessible or unresolved leads as gaps.
4. Capture exact quotes when wording matters, with URLs or file locations, author, date, and relevance to the question.
5. Record the queries and time windows searched, including searches that returned nothing.
6. Preserve contradictory evidence and alternative readings. Ask whether the same evidence would also be expected if your current explanation were wrong.

Keep concise evidence notes per category: searches performed, direct evidence, circumstantial evidence, contradictions, and gaps. A mechanics change proves what changed, not why. Claim author intent only from recorded statements; label interpretations separately. Evidence about a neighboring feature does not silently substitute for evidence about the target.

## 4. Weigh and verify

Combine duplicate references and compare evidence across sources. Surface contradictions with both citations rather than selecting the tidier story.

Apply the confidence tiers in [epistemics.md](references/epistemics.md). Cite every Direct or Supported claim. Make inference chains explicit and label speculation. Never use the code's behavior as evidence for its own intent.

Spot-check citations against their sources, and check any uncertain quote or attribution before presenting it. Review every conclusion for unsupported certainty, hidden gaps, recency bias, and untested agreement with the user's hypothesis.

## 5. Present

Use the following structure, omitting optional sections when they add nothing:

- **The question.** Briefly restate what is being explained.
- **The code in question.** Paths, line ranges, and key symbols.
- **What we found.** Mark claims `[Direct]` or `[Supported]`, with citations and the evidence supporting each.
- **What we can reasonably infer.** Mark claims `[Inferred]`, use calibrated language, and explain each inference chain. Optional.
- **Competing hypotheses.** State plausible alternatives, their supporting evidence, and counterevidence or missing evidence. Label speculation. Optional.
- **What we don't know.** Name unanswered questions, empty searches, inaccessible records, and unresolved leads. If no gaps remain, state the coverage supporting that assessment.
- **Sources consulted.** One entry for each of the seven categories, with the records, queries, and time windows inspected, or the explicit reason it was not searched. Distinguish unavailable sources from searches returning nothing.
- **Confidence summary.** State which conclusions are established and which remain uncertain.

When the question precedes a code change, add a Preserve / Change / Avoid / Risk constraint set after Sources consulted, grounded in the findings.
