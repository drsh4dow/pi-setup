---
name: writing-good-prs
description: Use when drafting or updating a pull request title or description, preparing before/after screenshots or videos for a PR, or writing a review-thread reply.
user-invokable: false
---

# Writing good PRs

Follow repository title and template conventions. Use a specific title that describes the change.

Write so a reviewer can explain the change before opening the diff: what motivates it, what happens afterward, why the consequential choices matter, and what was actually verified.

## Description

Default to concise paragraphs in this order: observable problem or new capability, mechanism and consequential choices, then verification and material gaps. This is an ordering preference, not a mandatory set of headings. Keep small PRs small; use sections for larger changes and lists for genuinely parallel information.

Use a concrete scenario when semantics are easy to misinterpret. Mention files and symbols only when they explain a decision or locate important review work. Include preserved behavior and scope boundaries when they resolve a likely reviewer concern; omit obvious code narration and incidental unchanged behavior.

Report the behavior exercised and the observed result, rather than relying on test counts or command inventories. Distinguish automated checks, isolated fixtures, and live integration verification. Name the environment or revision when it affects interpretation, and identify material unverified coverage. Reuse existing results unless later changes invalidate them; writing a description alone does not call for another testing campaign.

Reference related issues and stack dependencies. Use closing keywords only when the PR resolves the issue; otherwise use an ordinary reference. When updating a description, preserve valid human context and revise claims or evidence that changes made stale.

## Visual evidence

For meaningful visible changes, prefer before/after comparisons. Reuse suitable captures; when preparing a PR, capture missing evidence if the necessary runtime and tooling are available within the authorized work. If capture is unavailable, describe the material gap without blocking the description or expanding into environment provisioning.

- Show static differences with labeled, side-by-side Before and After screenshots, usually in a two-column Markdown table.
- Use short videos for motion, timing, focus handoffs, or interaction sequences that stills cannot demonstrate. Prefer paired before/after clips of the same scenario when both versions are available. Include stills alongside video when they make the key difference easier to inspect.
- Keep viewport, fixture data, and interaction steps comparable. Caption what the reviewer should observe; disclose material differences and label isolated fixtures versus live application captures. Never present an after-only capture as a before/after comparison.

Use [dumpfile](../dumpfile/SKILL.md) for authorized public evidence uploads. Include diagrams only when they explain architecture better than prose.

## Review replies

When a reply is requested, lead with the disposition, explain the relevant change or disagreement, and supply the decisive verification or source. Link the fixing commit when applicable. Address the concern directly and explain departures from a suggested remedy. Keep monitoring and thread-resolution procedures in [babysit-pr](../babysit-pr/SKILL.md); replying alone does not start that workflow.

## Example

Illustrative wording, only when supported by the actual work:

> Dismissing model settings briefly collapses the composer before editor focus returns. Keep it expanded through the focus handoff. On iPad with a hardware keyboard, dismissal now preserves the expanded card and typing resumes. Android runtime remains unverified.

The example connects a visible failure, its mechanism, an observed result, and a coverage boundary. A paired recording would demonstrate the focus handoff; the prose tells the reviewer what to watch for.

Before publishing, remove any sentence that adds neither needed context nor evidence, and check that each verification claim stays within what was actually observed.
