---
name: triage
description: Turn a batch of tickets someone else wrote into agent-ready work, with duplicates closed, stale tickets dropped, decisions grilled, and a parent spec over sub-tickets with blocking edges.
disable-model-invocation: true
user-invokable: true
---

# Triage

The user passes a **batch** of ticket ids, such as `/skill:triage ENG-101, ENG-104, ENG-107`, usually written by other people and short of the bar in [writing-good-tickets](../writing-good-tickets/SKILL.md). Triage reasons across the whole batch, not one ticket at a time. It ends with each ticket ready for an agent, closed with a reason, or waiting on a named person, and with the batch grouped by outcome, each group a parent spec over sub-tickets where the work calls for it. Tickets from [to-tickets](../to-tickets/SKILL.md) are already agent-ready, so they don't need triage.

Read the project's issue tracker record, `docs/agents/issue-tracker.md`, and its domain record, `docs/agents/domain.md`. If the tracker record is missing, stop and tell the user to run [setup-sh4dow-skills](../setup-sh4dow-skills/SKILL.md).

- **Reads** start from the record's **Fetch** and **Search**. Where they omit something the steps below need, such as children, linked PRs, or a linked document, use any read-only tool that reaches it, and list each gap in the report so setup can add it to the record.
- **Writes** go through the record's operations only. When the record names no **Edit**, use the tracker tool that updates an existing ticket by id, after its schema or `--help` confirms it does, and tell the user to rerun setup to record it.

Triage writes nothing to the tracker before step 6, and nothing there without the user's approval. When the user wrote a ticket, the decisions in it are the user's.

## The ledger

Keep the batch's state in `<state folder>/triage/<batch-slug>/`, with the state folder the system prompt defines:

- `raw/<id>.md`: each ticket as fetched, with its last-updated time.
- `grounding/<id>.md`: each grounding report from step 2.
- `drafts/<id or new-slug>.md`: each body from step 5.
- `plan.md`: the approved writes from step 6, each `pending`, `applied` with the id the tracker returned, or `verified`.
- `ledger.md`: one section per ticket, with its title, author, verdict, evidence, the decisions that settle it, and its open questions.

When `ledger.md` already exists for these ids, this is a resume. Fetch each ticket again. A ticket whose body changed or that has a new comment since its `raw/` file loses its grounding, its draft, and its approval: show the change, then redo those for it. Its settled decisions stand unless the change contradicts one, which you ask about again. Don't re-ask resolved questions.

Each ticket carries one **verdict**, kept in the ledger. A ticket that bundles separate pieces of work gets a verdict per piece, and the structure in step 3 splits it.

| Verdict | Means |
| --- | --- |
| `duplicate` | Another ticket covers the same work. Names the canonical ticket. |
| `implemented` | The behavior already exists on the branch production deploys from. Names where. |
| `obsolete` | The need behind it is gone. Names the evidence. |
| `needs-decision` | A decision the user can make is still open, or grounding could not settle the claim. |
| `needs-author` | A question only someone else can answer is open. Names that person. |
| `parent` | The spec over a group's sub-tickets, in the template of [to-spec](../to-spec/SKILL.md). |
| `ready-for-agent` | Specified to the writing-good-tickets bar, and an agent can take it. |
| `ready-for-human` | Specified to the same bar, but it needs judgment, access, or manual testing that an agent can't supply. Says which. |

## 1. Snapshot

Fetch each ticket in full: body, every comment, relations (parent, children, blockers, duplicates), project, attachments, linked PRs, and the PRs its body references. Fetch its parent and the documents its project links too, because a parent often carries the reason for the work. Save each one to `raw/<id>.md`.

Judge every ticket from its snapshot, never from a search listing, because a listing omits the comments, and a comment may already say the work is done.

Done when every ticket in the batch has a `raw/` file that holds its comments, relations, and linked PRs.

## 2. Ground

For each ticket, launch one delegate subagent per [subagents](../subagents/SKILL.md), at most four at a time, from the project directory so the tracker tools reach them. Redirect each one's stdout to `grounding/<id>.md`. Pin it to one commit of each repository it reads, the tip of the branch production deploys from unless the ticket's work lives on an open PR, and have it name that commit. It writes nothing to the tracker and changes nothing in a shared checkout. A reproduction that writes files, such as a build or a test run, runs in its own worktree or scratch directory, and a claim it could not reproduce says it rests on reading the code.

Give it the ticket's `raw/` file, the glossary and ADRs for its area, and this task:

- **Redundancy.** Search for an existing implementation of the requested behavior by domain concept (not just the request's wording), and report where you looked. Search the PRs of the repositories the ticket targets for its id, and say which merged and what they changed.
- **Claim.** For a bug, find the code path and say whether it still behaves as the ticket describes, reproducing it when that takes a few minutes. For a feature, say what the code does today. Report confirmed, failed, or insufficient detail.
- **Language.** List each term the ticket uses that conflicts with the glossary, or that names a concept the glossary lacks.
- **Open decisions.** List each product or design choice an implementer would have to guess, and who could make it: the user, or a person the ticket names.
- **Verdict.** Propose one verdict from the ledger's table, or one per piece of a bundled ticket.

The report opens with a summary of at most ten lines: the verdict, the decisive evidence, the open decisions, and the overlaps it noticed. Every claim in the report cites a code symbol, a commit, a PR, or a comment, or says `not checked`. Read the summaries, and open the full report for the evidence behind each closure. Rerun a report whose verdict cites nothing once. When it still cites nothing, the verdict is `needs-decision`, and the gap becomes a question in step 4.

Done when every ticket has a grounding report and a cited verdict.

## 3. Map the set

Compare the tickets with each other. Matching is by concept similarity, not keyword. Then **Search** the tracker for each concept the batch covers, with several phrasings, because the tracker matches words. List the open tickets outside the batch that overlap it as **neighbors**. Fetch a neighbor in full before the structure relies on it.

Propose a structure:

- **Groups.** One group per outcome the batch serves. A ticket that shares no outcome stays on its own.
- **Parent spec.** For a group that needs one, promote the existing ticket that covers its outcome, in the batch or a neighbor. Create a new parent only when none does.
- **Sub-tickets.** Slice each group's work by the vertical-slice rules in to-tickets, each slice with its blocking edges. A ticket that covers two slices splits. Tickets that cover the same slice merge into the one with the most history (comments, links, PRs), and the rest become its duplicates.
- **Closures.** Each `duplicate`, `implemented`, and `obsolete` ticket or piece, with its evidence.
- **Changes to existing tickets.** For each ticket the structure touches, neighbors included: which slice keeps its id, and what happens to its existing parent, children, and blockers.

Present a table with one row per ticket (id, title, proposed verdict, overlaps, evidence), then the structure, then the neighbors. Every neighbor the structure does not touch stays unchanged. Wait for the user to approve or change the structure.

Done when the user approves a structure.

## 4. Grill

Run [grilling](../grilling/SKILL.md) and [domain-modeling](../domain-modeling/SKILL.md) together over one design tree for the whole batch. Seed the tree with every open decision, term conflict, and unsettled claim from the grounding reports. Ask a decision that several tickets share once, before the decisions that hang off it, and record in the ledger which tickets it settles. Update the glossary and ADRs as decisions land, per the domain record.

A question only someone else can answer, such as a product call the ticket's author owns, is **parked**: draft it as a comment for that person, mark its ticket `needs-author`, and take the branches that depend on it off the tree. Questions must be specific and actionable, not "please provide more info".

Done when the frontier holds only parked questions and the user confirms you have reached a shared understanding.

## 5. Draft

Write each parent spec in the to-spec template, and each sub-ticket per writing-good-tickets. Each decision from step 4 lands in one place: an observable behavior in the ticket's `## Done when`, a design choice in its `## Suggested approach` or the parent's Implementation Decisions, and a term in the glossary.

An existing ticket keeps its author's text, quoted line by line under a `### Original description` heading at the end of its last section, with the author and date. When the fetched body already has that heading, from an earlier triage, keep that block as it is and quote nothing else.

Pass each sub-ticket through the two gates in the "Check the body" section of writing-good-tickets: the structure check, then one implementer read. A sub-ticket that passes both, with no parked question, takes `ready-for-agent` or `ready-for-human`. A sub-ticket with a parked question keeps `needs-author`, and so does each ticket it blocks.

Done when every draft is in `drafts/` and every sub-ticket without a parked question passed both gates.

## 6. Write back

Show the user, for each ticket: the diff from its `raw/` body to its draft, the relation and state changes, and the comment you will post. Write the writes the user approves to `plan.md` as `pending`, in dependency order: parents, then sub-tickets with each blocker before what it blocks, then relations, then closures, then comments, including each parked question.

Apply the plan one write at a time, and mark each `applied`, with the id the tracker returned, before the next:

- Fetch each ticket just before its first write. When it changed since its `raw/` file, stop, show the change, and ask again. Its later writes need no fresh check, because the plan's own writes change it.
- Publish or edit each body by the publish steps in writing-good-tickets. Use the record's **Nest under a parent** and **Block** for relations, **Close** for closures, in its duplicate form for a duplicate, and **Comment** for each ticket's comment, which says what triage changed and the decisions behind it.
- When the tracker already has a ready-for-agent label, apply it to each ready ticket. Create no labels.
- Leave the fields triage did not decide, such as assignee, priority, and estimate, as they are.
- After a failed or lost response, **Search** or **Fetch** for the write before retrying it, so a retry never creates a second ticket or comment.

Fetch every ticket the plan touched and compare it with the plan: body, title, parent, blockers, duplicate target, state, label, and each planned comment. A body includes any `Part of` or `Blocked by` line the record's relation fallback adds. Mark each match `verified`. Fix each difference at its cause once, and report the differences that remain.

## 7. Report

List each ticket with its verdict, its link, and what changed, the parked questions and whom they wait on, the neighbors left unchanged, the record gaps found in steps 1 and 6, and the ledger's path.
