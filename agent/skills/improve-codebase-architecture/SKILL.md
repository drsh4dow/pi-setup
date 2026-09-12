---
name: improve-codebase-architecture
description: Find concrete architectural simplifications and present a visual HTML report.
disable-model-invocation: true
---

# Improve codebase architecture

Find deletions and simplifications that reduce actual maintenance friction. Use [codebase-design](../codebase-design/SKILL.md) for design principles and the project's glossary and relevant ADRs for domain context.

## Explore

Start with the user's named area. Otherwise use recent history to identify frequently changed code, then inspect it for repeated decisions, hidden state, shallow wrappers, and knowledge spread across callers.

Each candidate must have concrete evidence of friction. Apply the deletion test: does removing the module eliminate complexity or redistribute it? Avoid speculative test seams, scaffolding, and theoretical refactors. Finding no worthwhile change is a valid result.

## Present

For this command, write an HTML report in the OS temp directory and provide its absolute path. Open it with the platform's normal opener when available. Follow [HTML-REPORT.md](HTML-REPORT.md); an explicitly requested output format takes precedence.

For each candidate, show the affected files, evidence of the problem, proposed simplification, maintenance benefit, migration cost, and recommendation strength. Include a before/after visual when it explains the change. Identify meaningful uncertainty and any conflict with an existing ADR.

Recommend the strongest candidate, or explain why no change earns its cost. This report completes an analysis request.

## Follow the requested next step

If the user wants to explore a candidate, compare unresolved choices directly. Use [grilling](../grilling/SKILL.md) when an interview is requested, and [domain-modeling](../domain-modeling/SKILL.md) when recording terms or decisions is authorized. Implement only when implementation is part of the task.
