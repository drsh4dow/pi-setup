---
name: how
description: "Use for \"how does X work\", code walkthroughs before changing something, and placement / ownership / layering questions (\"where should this live\", \"which package owns this\", \"is this the right layer\"). Explains subsystem architecture, runtime flow, onboarding mental models. Use why for motivation."
disable-model-invocation: false
---

# How

Trace the code yourself and explain it for an engineer unfamiliar with the subsystem. Keep the investigation read-only.

## 1. Scope the question

If the scope is ambiguous, state your interpretation and explore. The user can redirect.

For a narrow question, trace the relevant path directly. For a subsystem spanning multiple files or services, identify two to four distinct exploration angles and cover each before explaining. Parallelize independent searches and reads where useful.

## 2. Trace the behavior

Find relevant files and symbols, then read their implementations. Names alone are not evidence.

1. Find the entry point and what triggers it.
2. Follow the call chain and data transformations, including important branches.
3. Read the central types and abstractions. Identify what they represent and which module owns each responsibility.
4. Trace connections to other subsystems, including their inputs and outputs.
5. Identify non-obvious behavior, pitfalls, and anything a newcomer could misread.

Keep concise findings with file paths, symbols, and line references. For broad questions, combine the explored paths into one account and resolve contradictions against the source. Continue until you can trace the requested behavior from its trigger to its observable result, or identify the exact connection you could not establish. State unresolved gaps rather than guessing.

## 3. Explain

Use these sections when they help answer the question. Omit sections that do not apply:

- **Overview.** What it does and where it fits, in one or two paragraphs.
- **Key concepts.** The types and abstractions needed to understand the flow.
- **How it works.** What triggers it, what runs, where data goes, and where decisions happen. Cite concrete files and functions rather than reproducing source code.
- **Where things live.** The few files or directories a maintainer needs to start working here.
- **Gotchas.** Surprising behavior, pitfalls, and unresolved connections.

Include a Mermaid or ASCII diagram when relationships or data transformations are clearer visually. Skip diagrams that merely repeat the prose. Scale the explanation to the question; a small utility does not need an architectural report.

Explain historical motivation only when supported by evidence. Use `why` when the question requires investigating intent.
