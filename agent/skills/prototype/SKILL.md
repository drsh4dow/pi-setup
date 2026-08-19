---
name: prototype
description: Use for throwaway design experiments.
disable-model-invocation: false
user-invokable: false
---

# Prototype

A prototype is **throwaway code that answers a question**. The question decides the shape.

## Pick a branch

Identify which question is being answered — from the user's prompt, the surrounding code, or by asking if the user is around:

- **"Does this logic / state model feel right?"** → [LOGIC.md](LOGIC.md). Build a single shareable HTML file — free-play buttons plus tabbed guided walkthroughs — that pushes the state machine through cases that are hard to reason about on paper, and that a non-developer can drive.
- **"What should this look like?"** → [UI.md](UI.md). Build one UI direction, or compare materially different variations on a single route when the experiment-size gate below calls for them.

The two branches produce very different artifacts — getting this wrong wastes the whole prototype. If the question is genuinely ambiguous and the user isn't reachable, default to whichever branch better matches the surrounding code (a backend module → logic; a page or component → UI) and state the assumption at the top of the prototype.

## Choose the experiment size

Build one prototype when it can answer the question. This is the default. A concrete direction, an established local pattern, or constraints that leave one viable shape do not justify alternatives.

Use 2-3 competing candidates only when all of these hold:

- The question is empirical. Running or using the artifact will reveal something that inspection and argument will not.
- At least two materially different shapes remain viable.
- Choosing the wrong shape would cost more than the extra prototypes.

Before building candidates, declare 3-5 selection rules tied to the question. Each rule must be observable in the prototype, such as task completion steps, discoverability in a named scenario, illegal transitions prevented, or information visible without navigation. Give every candidate the same scenario and representative data. Keep candidates separate enough to preserve their disagreement, but use the cheapest artifact that exposes it. Parallel delegation is optional, not the default.

Run every candidate against the declared rules and record observations, not aesthetic votes. Pick the strongest candidate as the base. Graft a losing candidate's part only when it improves a declared rule and fits the base's mental model. Re-test the combined result. If candidates diverge because the question or rules were vague, tighten them rather than averaging the candidates. The deliverable remains one answer and one retained prototype source, with a short record of the base, grafts, rejections, and observed result.

For interface alternatives whose differences can be judged from types, invariants, and seam placement without running code, use `codebase-design` and its Design It Twice process instead.

## Rules that apply to both

1. **Throwaway from day one, and clearly marked as such.** Locate the prototype code close to where it will actually be used (next to the module or page it's prototyping for) so context is obvious — but name it so a casual reader can see it's a prototype, not production. For throwaway UI routes, obey whatever routing convention the project already uses; don't invent a new top-level structure.
2. **Trivial to run.** A UI prototype starts from one command in the project's task runner — `pnpm <name>`, `python <path>`, `bun <path>`, etc. A logic demo is a single HTML file the user double-clicks. Either way, no thinking required to start it.
3. **No persistence by default.** State lives in memory. Persistence is the thing the prototype is _checking_, not something it should depend on. If the question explicitly involves a database, hit a scratch DB or a local file with a clear "PROTOTYPE — wipe me" name.
4. **Skip the polish.** No tests, no error handling beyond what makes the prototype _runnable_, no abstractions. The point is to learn something fast.
5. **Surface the state.** After every action (logic) or on every variant switch (UI), print or render the full relevant state so the user can see what changed.
6. **Capture it when done.** Fold any validated decision into the real code and remove prototype-only paths from the production change. Keep the prototype locally as a primary source until the user decides whether to retain it. Only with explicit approval, preserve it on a throwaway branch and link that branch from the implementation issue. Record the verdict and the question it settled in the approved destination. The main branch keeps only the validated decision.
