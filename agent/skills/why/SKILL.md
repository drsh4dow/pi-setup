---
name: why
description: Use to investigate code and design rationale.
disable-model-invocation: false
user-invokable: false
---

# Why

Recover the forces that shaped code or a decision. Treat intent as a historical claim, not something code can prove about itself.

## Frame the question

Identify the target and the kind of answer sought: design rationale, rejected alternative, motivating edge case, external constraint, regression history, continued necessity, or a numeric threshold.

If the referent is unclear, use the conversation, recent edits, and open paths to choose the narrowest plausible target. State that interpretation in the answer. If the user asks what the code does at runtime, inspect it directly without using this workflow. If the investigation resolves or changes domain language or a durable decision, hand that result to `domain-modeling`; do not silently rewrite the historical record.

## Anchor the investigation

Locate the relevant paths, line ranges, symbols, and tests. Establish the history before searching elsewhere:

```bash
git blame -L <start>,<end> <file>
git log --follow -p -- <file>
git log --oneline -20 -- <file>
git show --stat --format=fuller <commit>
```

Follow renames and earlier implementations when the current lines are recent. Extract PR numbers, issue IDs, incident names, dates, authors, feature names, and distinctive literals. Use `gh pr view` and `gh issue view` for linked repository records. Read the full body, review discussion, and linked records, not only titles.

Code, tests, and diffs establish mechanics and chronology. A comment may establish intent when it states a reason. Code shape alone does not.

## Choose evidence that can change the answer

Form two or more live hypotheses, including the user's proposed reason when present. For each source category, ask:

1. What claim or uncertainty could this source resolve?
2. What concrete clue connects the target to that source?
3. Would a positive or negative result change the answer or its confidence?

Search the category only when all three have an answer. This relevance gate replaces blanket fanout. Record unavailable high-value sources as gaps. Do not call a source merely to report that it returned nothing.

Use these branches:

- **Source control and repository records.** Always inspect git history. Search GitHub PRs and issues when commits, IDs, authors, dates, labels, or repository search terms provide a route. This is strongest for implementation-time rationale and review tradeoffs.
- **Local design and product documents.** Search `CONTEXT.md`, `CONTEXT-MAP.md`, `docs/adr/`, RFCs, specs, postmortems, changelogs, and nearby docs when the target names a domain term, durable choice, rollout, incident, or product constraint. A glossary defines language, not necessarily the reason for implementation.
- **External primary sources.** Invoke `web-search` only when an outside API, standard, vulnerability, browser behavior, legal rule, or dependency version could have forced the decision. Prefer the specification, vendor documentation, release notes, advisory, or upstream source. Public material cannot establish the team's intent unless a repository record links it; otherwise it supports only the external constraint.
- **Issue trackers beyond GitHub, team chat, observability, error tracking, or analytics.** Search only when the environment exposes a relevant tool and the anchor supplies a lead such as a ticket ID, permalink, metric name, error signature, incident window, experiment key, event name, or threshold. Analytics is especially relevant to data-backed constants; errors and observability to defensive code and regressions.

A broad historical question may justify several branches. Run independent searches in parallel with available Pi tools. Delegate only a bounded source-specific investigation when it saves material reading time. Give it the question, code anchor, one source, hypotheses it can discriminate, and a required report of exact queries, citations, contradictions, and gaps. Inspect delegated evidence before using it.

Stay read-only. Do not message people, alter tickets, run production queries with side effects, or make other outward changes without user approval.

## Gather evidence

Search broad terms from the anchor first, then narrow by date, author, ID, symbol, literal, or release. Follow links within relevant records. For every useful item capture:

- the exact claim or quote;
- a verifiable citation such as commit hash, PR or issue number, URL, or `file:line`;
- author and date when they affect authority or chronology;
- whether it is direct motivation, circumstantial evidence, or a lead;
- credible alternative readings.

Track the exact searches that came up empty when the missing result matters. Absence of a record is a gap unless the search had enough coverage that the record should have appeared. Look for evidence against each live hypothesis. Preserve disagreements between tickets, PRs, docs, comments, and later retrospectives. Later sources may describe changed reasoning rather than original intent.

Stop when further available searches cannot distinguish the remaining hypotheses or materially change confidence. A single explicit contemporary explanation may be enough. A plausible story assembled only from code is not.

## Calibrate claims

Assign every conclusion one tier:

- **Direct.** A source explicitly states the reason. State it plainly and cite it.
- **Supported.** Several independent indirect facts converge. Name each fact and the inference they support.
- **Inferred.** A reasonable interpretation lacks explicit support. Use `appears to`, `likely`, `suggests`, or `is consistent with`, and show the inference chain.
- **Speculative.** Several explanations fit thin evidence. Present each as a possibility and state what evidence is missing.
- **Unknown.** Relevant searches did not recover the answer. State what was searched and what remains unavailable.

Reserve causal wording such as `because`, `the reason is`, and `was designed to` for direct or strongly supported claims with adjacent citations. Never convert current coherence into historical intent. Never treat the user's hypothesis as established. Never turn an unsearched or incomplete record into evidence of absence.

Before answering, check every direct and supported claim against its source. Move uncited claims to inference, hypothesis, or unknown. If sources conflict, report both and explain whether chronology, scope, or authority resolves the conflict. Otherwise leave it unresolved.

## Present the result

Use only sections that carry information, while preserving this confidence separation:

1. **Question and code anchor.** Restate the target, paths, lines, and symbols.
2. **Direct and supported findings.** One cited claim per bullet with its confidence tier.
3. **Reasonable inferences.** Hedged claims with visible inference chains.
4. **Competing hypotheses or contradictions.** Evidence for and against each when the record does not settle them.
5. **Unknowns and gaps.** Specific unanswered questions, failed searches, unavailable high-value sources, and who or what record could settle them.
6. **Sources consulted.** For each selected category, list tools, queries or records, and the result. List skipped categories only when their absence creates a material blind spot, with the relevance or availability reason.
7. **Confidence summary.** State which rationale is established and which parts remain uncertain.

If the investigation precedes a code change, finish with `Preserve`, `Change`, `Avoid`, and `Risk` constraints derived from the evidence. Do not present inferred constraints as settled requirements.
