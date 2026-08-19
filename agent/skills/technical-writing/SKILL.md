---
name: technical-writing
description: Use for developer documentation structure and ambiguity.
disable-model-invocation: false
user-invokable: false
---

# Technical writing

Write documentation that a tired engineer can use on the first read. This skill owns document architecture, instructional structure, and ambiguity control. Apply `unslop` for sentence-level tone, filler, rhythm, and AI writing patterns.

## Workflow

1. Identify the reader, their goal, and the evidence available in the repository.
2. Choose the document mode for each coherent section.
3. Build headings around the reader's path through the material.
4. Draft with real symbols, paths, commands, limits, and expected results.
5. Resolve every sentence that permits two materially different readings.
6. Verify factual claims against the current repository and run documented commands when the task permits.
7. Review the finished document against the checklist.

If the requested audience, goal, scope, or behavior is unclear, do not silently invent it. Resolve the uncertainty from nearby code and existing docs when one interpretation is clearly established. Otherwise, state the assumption or ask for the decision before writing claims that depend on it.

## Choose the mode

Use four modes to decide what belongs together:

- **Tutorial:** learning through a guided, successful exercise.
- **How-to:** completing a real task with assumed competence.
- **Reference:** looking up facts, options, limits, and errors.
- **Explanation:** understanding a bounded topic, its reasons, and its tradeoffs.

A short page can use one mode. A README, RFC, or longer guide may need several clearly labeled sections. Keep each section internally consistent, and split or link when a second mode would interrupt the reader's current goal.

### Tutorial

Open with what the reader will build or run. Give a sequence in which each step has an observable result. Include expected output, state changes, or other checks often enough that the reader can detect drift early. Keep background brief and link to deeper explanation.

### How-to

Name the goal in the title and start near the first action. Assume the reader knows the underlying concepts. Include prerequisites that affect success, conditions before the actions they govern, and branches only where the task genuinely differs. Move background and exhaustive option lists to explanation or reference material.

### Reference

Mirror the structure and names of the system being described. State signatures, defaults, valid values, limits, side effects, and errors where they matter. Keep claims factual and easy to scan. Prefer a maintained generated source when the repository already has one, but do not introduce generation solely to satisfy this skill.

### Explanation

Anchor the section on a specific question. Describe constraints, decisions, alternatives, and consequences. Make the reasoning explicit enough that a reader can tell which facts are fixed and which choices are judgments. Keep procedures and exhaustive lookup material in their own sections or linked documents.

## Build the document

Put the information needed to decide whether the page applies near the top. Arrange the rest in the order the reader needs it, not the order in which the author discovered it.

Use headings that tell the reader what each section does. Task headings use verb phrases. Concept headings use noun phrases or specific questions. Follow the repository's heading and formatting conventions when they exist.

Use numbered lists for required sequences and bullets for unordered peers. Introduce a list with enough context to define what its items represent. Keep list items grammatically parallel.

For procedures:

- Write direct commands.
- Put a condition before the action it controls.
- Give one action per numbered step unless the actions are inseparable.
- State the expected result where it helps the reader catch an error.
- Put warnings before the step that creates the risk.
- Distinguish required actions from optional ones.

Use the exact names from the implementation for symbols, files, flags, settings, and UI elements. Follow local conventions for code fences, indentation, links, and terminology. If the repository has no convention, choose a common readable form and use it consistently.

## Control ambiguity

Read each sentence as if the reader cannot ask the author what it means. Rewrite when two plausible readings would lead to different actions or conclusions.

- Put `only`, `not`, and similar modifiers next to the words they modify.
- Give every pronoun one obvious referent. Repeat the noun when two referents are possible.
- Keep the verb in each clause. Do not rely on an omitted verb when the result can be misread.
- Break long noun strings into clauses that show the relationships between the nouns.
- Use articles when they distinguish one object from a class of objects.
- State the scope of `and` and `or`. Use forms such as `both ... and` or `either ... or` when grouping is unclear.
- Use one term for one concept. Introduce an alias only when readers must recognize it elsewhere.
- Separate a condition, an action, and a consequence when combining them hides which one governs the others.
- Replace a dangling `this`, `which`, or `it` with the fact or object it refers to.
- Spell out combinations when a slash could mean `and`, `or`, or both.

Do not shorten a sentence if the removed words carry structure. Clarity takes precedence over a word-count target.

## Handle evidence and uncertainty

Documentation is part of the repository's behavior contract. Check claims against code, tests, configuration, and command output that exist at the current revision.

- Do not guess a default, supported value, path, or error behavior.
- Label examples as examples when their values are not requirements.
- Separate observed behavior from a proposed design in RFCs and migration plans.
- Date or qualify claims that can change independently of the repository.
- Include regeneration or verification commands for generated facts when the repository has a stable command for them.
- If a command cannot be run, say what remains unverified instead of presenting the expected result as observed.

## Review checklist

1. Is the reader and their goal clear near the start?
2. Does each section stay in one mode, or mark a deliberate transition?
3. Can the reader find prerequisites, actions, expected results, facts, or reasoning where that mode promises them?
4. Are conditions and warnings placed before the actions they govern?
5. Do modifiers, pronouns, conjunctions, and noun groups permit only the intended reading?
6. Does each concept keep one name, using the implementation's real names where applicable?
7. Are defaults, limits, paths, commands, and outputs verified or explicitly marked unverified?
8. Does the structure follow repository conventions without copying stale information from the environment?
9. Has `unslop` been applied without removing necessary precision or structure?
