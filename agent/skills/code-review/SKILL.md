---
name: code-review
description: Use for code review, including adversarial multi-model review.
disable-model-invocation: false
user-invokable: false
---

# Code review

Review the diff between `HEAD` and a fixed point on two independent axes:

- **Standards**: Does the code conform to this repo's documented coding standards?
- **Spec**: Does the code faithfully implement the originating issue or spec?

Keep these axes separate so success on one cannot mask failure on the other. Delegate only work that benefits from an isolated context. Treat delegate reports as leads to verify against the repository, never as proof. This is a read-only workflow: report findings, but do not edit code, create commits, or take outward actions.

Use `docs/agents/issue-tracker.md` when it exists. If no tracker instructions are available, establish intent from local evidence and report the missing Spec source.

## Process

### 1. Pin the fixed point

Use the fixed point the user supplied, such as a commit SHA, branch, tag, `main`, or `HEAD~5`. If none was supplied, ask for it.

Capture these commands once:

- `git diff <fixed-point>...HEAD`
- `git log <fixed-point>..HEAD --oneline`

Confirm the fixed point resolves with `git rev-parse <fixed-point>` and the diff is non-empty. Stop on a bad ref or empty diff rather than passing a broken scope to delegates.

### 2. Establish intent and the spec source

State one short paragraph describing what the change is trying to accomplish. Derive it from the user's request, commit messages, PR description or issue, and the code. Ask the user only when materially different interpretations remain.

Find the originating spec in this order:

1. Issue references in commit messages, fetched through `docs/agents/issue-tracker.md`.
2. A path supplied by the user.
3. A file under `docs/`, `specs/`, or `.scratch/` matching the branch or feature.
4. The stated intent, only if the user confirms there is no separate spec.

If no source can be established, ask. If the user confirms there is no spec, skip the Spec axis and report `no spec available`.

### 3. Identify standards sources

Find repository documents that govern the changed code, such as `CODING_STANDARDS.md`, `CONTRIBUTING.md`, and applicable `AGENTS.md` files.

The Standards axis also uses this Fowler smell baseline:

- **Mysterious Name**: A name does not reveal what it does or holds. Rename it; if no honest name exists, inspect the design.
- **Duplicated Code**: The same logic shape appears in multiple changed sites. Share the shape when doing so reduces total complexity.
- **Feature Envy**: A method reaches into another object's data more than its own. Consider moving behavior to the data owner.
- **Data Clumps**: The same fields or parameters repeatedly travel together. Consider one domain type.
- **Primitive Obsession**: A primitive stands in for a domain concept that needs enforced rules. Consider a small domain type.
- **Repeated Switches**: The same branch cascade over one type recurs. Centralize the decision or use polymorphism when it simplifies the code.
- **Shotgun Surgery**: One logical change requires scattered edits. Gather the changing behavior in its canonical module.
- **Divergent Change**: One module changes for unrelated reasons. Split responsibilities when the separation is real.
- **Speculative Generality**: An abstraction, parameter, or hook has no current requirement. Delete or inline it.
- **Message Chains**: A caller depends on a long navigation chain. Hide the traversal behind the object that owns it.
- **Middle Man**: A function or class mostly delegates. Call the real target directly.
- **Refused Bequest**: An implementer ignores most inherited behavior. Prefer composition.

Repository rules override this baseline. Smells are judgment calls, not hard violations. Skip checks that tooling already enforces.

### 4. Run the two axes in parallel

Launch the applicable delegates together with read-only instructions.

The **Standards delegate** receives the diff command, commit list, standards-source paths, and the full smell baseline. Ask it to report, by file and hunk:

- every documented-standard violation, citing the source file and rule;
- each plausible baseline smell, naming it and quoting the hunk;
- whether each item is a hard documented breach or a judgment call.

Tell it to skip tool-enforced rules and stay under 400 words.

The **Spec delegate** receives the diff command, commit list, intent paragraph, and spec path or contents. Ask it to report:

- missing or partial requirements;
- behavior outside the requested scope;
- requirements that appear implemented incorrectly.

Require a quoted spec line or intent sentence for each finding and a concrete code location. Keep it under 400 words.

### 5. Add adversarial reviewers selectively

Use this branch when the user asks for adversarial review, multi-model review, a challenge, blind spots, a stress test, or to tear the code apart. For an ordinary review, the two axis delegates are enough.

Choose two independent reviewers for a small, localized diff and three for a broad, security-sensitive, stateful, concurrent, or migration change. Add a fourth only when the change has distinct risk domains that the first three cannot cover. Use different available model families when the delegation tool supports model selection. Model diversity supplies different priors; assigned personas do not.

Send every adversarial reviewer the same intent, diff command, commit list, spec source, standards sources, and rubric. Require read-only investigation of adjacent callers, callees, types, and tests where needed. The rubric is:

- trace concrete correctness, error, state, concurrency, idempotency, and security paths;
- test whether the implementation addresses the root cause and fits the canonical layer;
- check behavioral verification, especially changed failure and integration paths;
- challenge unnecessary abstraction, compatibility paths, branching, and configuration;
- distinguish a demonstrated defect from a preferred alternative;
- classify each finding as Standards or Spec, cite `file:line`, give evidence, and use severity `critical`, `warning`, or `nit`;
- return `no findings` rather than padding the report.

Do not give reviewers one another's output. Independence is required for agreement to carry weight.

### 6. Verify, deduplicate, and dispose

Read every delegate report, then inspect the cited code and surrounding path yourself. Dismiss claims whose execution path, governing rule, or spec basis does not hold.

Merge findings only when they identify the same underlying defect and remedy. Preserve distinct consequences when one cause creates separate user-visible failures. Record which reviewers raised each merged finding.

Agreement is evidence, not a vote:

- Independent agreement from two or more reviewers raises confidence.
- A lone correctness or security finding still deserves full tracing.
- Explicit disagreement must be recorded with the evidence that resolves it, or left unresolved if the repository does not decide it.
- Similar wording without independent reasoning is not consensus.

Assign every verified or rejected finding one disposition:

- **Act on**: A concrete correctness, security, spec, or maintainability problem that should block the change.
- **Consider**: A real tradeoff whose benefit may not justify its cost in this change.
- **Noted**: Valid context with no current action.
- **Dismissed**: Incorrect, unsupported, tool-enforced, out of scope, or merely stylistic.

Keep each finding on its originating Standards or Spec axis. Include severity, location, source reviewers, consensus status, disposition, and one-line rationale. Cap `Act on` at the real blockers rather than promoting weak findings to fill a list.

### 7. Report

Start with:

## Intent

> The intent paragraph.

Then report:

## Standards

Group findings by `Act on`, `Consider`, `Noted`, and `Dismissed`. In an ordinary review with no adversarial branch, the same dispositions still apply, but omit reviewer-agreement metadata.

## Spec

Use the same groups, or report `no spec available`.

For an adversarial review, add:

## Agreement map

List merged consensus findings, lone-reviewer findings, and explicit disagreements. State what evidence resolved each disagreement. Name each reviewer by model when known and report its raw finding count.

End with one line giving the finding count by disposition within each axis and the worst issue on each axis. Do not choose a winner across axes.
