---
name: code-review
description: "Review the changes since a fixed point (commit, branch, tag, or merge-base) with a panel of persona subagents, one lens each: spec fidelity, standards, logical proof, simplification, readability, comments, prose, security, and tests. Use when the user wants a branch, a PR, or work-in-progress changes reviewed, asks to review since X, or asks for an adversarial or multi-model review, to challenge, stress-test, or tear apart code."
disable-model-invocation: false
user-invokable: true
---

# Code review

Review the diff between `HEAD` and a fixed point with a panel of reviewers. Each reviewer is a subagent holding one lens, its **persona**, so no lens crowds out another. You are the lead: you pick the personas, verify what they report, and judge it. The deliverable is a verified review. Nothing is applied.

## 1. Pin the fixed point

Take the fixed point the user gave: a SHA, branch, tag, `main`, or `HEAD~5`. When they gave none, use the merge-base with the default branch and say so.

Confirm it resolves (`git rev-parse <fixed-point>`) and the diff is non-empty. A bad ref or empty diff fails here, not inside the panel. Capture:

- The diff command: `git diff <fixed-point>...HEAD`, three dots, so it compares against the merge-base. Add the working tree when the user asks to include uncommitted work.
- The commits: `git log <fixed-point>..HEAD --oneline`.

## 2. Gather the inputs

- **Spec.** In order: issue references in the commit messages, fetched through the **Fetch** operation of the project's issue tracker record (`docs/agents/issue-tracker.md`); a path or issue the user passed; the PR description. Without a spec, state the intent in one paragraph from the commits and the code, and mark it as inferred.
- **Standards.** The standards record, `docs/agents/standards.md`, with its standards sources and guardrail commands. When it is missing, search the repository for files that document how code is written (`CODING_STANDARDS.md` and `CONTRIBUTING.md` always count), find the check commands in its scripts and CI, and mention the **setup-sh4dow-skills** skill in the report.

## 3. Pick the panel

Read `git diff --stat` and the hunks, then pick personas from the table. Every persona file is in [`personas/`](personas/).

| Persona | Seat | Runs |
| --- | --- | --- |
| [spec-fidelity](personas/spec-fidelity.md) | detail | always. Against the inferred intent when there is no spec |
| [standards](personas/standards.md) | detail | always |
| [logical-proof](personas/logical-proof.md) | detail | always |
| [simplifier](personas/simplifier.md) | taste | always |
| [reader](personas/reader.md) | taste | always |
| [comment-sicko](personas/comment-sicko.md) | taste | the diff's added lines (`+`) hold comments, or lint and type suppressions. Read the lines, not the file list |
| [unslop](personas/unslop.md) | taste | the diff adds or changes prose: docs, skill or prompt files, user-facing strings, or commit messages |
| [security](personas/security.md) | detail | the diff touches untrusted input, authentication or authorization, file paths, shell or process execution, outbound requests, secrets, cryptography, dependencies, or model input and output |
| [tests](personas/tests.md) | detail | the diff changes behavior or tests |

A diff that touches only prose runs spec-fidelity, standards, and unslop, plus security when the prose is agent instruction, such as a skill, a prompt, or an agent file, since an agent executes it. Record each skipped persona and why.

## 4. Assign models

A detail seat takes the **subagents** skill's `code-review detail personas` role, and a taste seat runs `anthropic/claude-opus-5-5`.

## 5. Launch the panel

Write one assignment per persona, per the **subagents** skill. Each is a delegate whose write scope is nothing in the repository. Its assignment holds the diff command, the commits, the fixed point, the spec or inferred intent, the standards record or the files you found, the guardrail commands, and the done condition: every hunk in scope read through the persona's lens. Give a persona the artifact and the contract, never the journey: leave out your reasoning about the change and what you expect it to find. The contract includes the user's recorded decisions and the binding orders, marked as settled, so a persona grades against them instead of re-proposing a declined call. A reviewer handed your conclusions returns validation of them.

The review's folder is `reviews/<branch>-<short-sha>/` in the state folder, as an absolute path. Write each assignment to `<persona>.brief.md` in the review's folder, then start the personas all at once with `bg_start`, through the **subagents** skill's launcher. Each launch appends its persona file and the shared finding format, passes the standing-orders file of the playbook running the review (or `none` when it keeps none), and writes its report to `<persona>.md` in the review's folder:

```bash
$HOME/.pi/agent/skills/subagents/scripts/launch.ts \
  --kind delegate \
  --role persona \
  --brief "<review folder>/<persona>.brief.md" \
  --orders "<orders file, or none>" \
  --append "<this skill's directory>/personas/<persona>.md" \
  --append "<this skill's directory>/references/finding-format.md" \
  --model <model> \
  --thinking high \
  --name "subagent: code-review <persona>" \
  > "<review folder>/<persona>.md"
```

An exit 2 means the launcher refused the assignment and started no persona: fix the cause it printed and launch that persona again.

## 6. Verify and judge

Read each persona's report from its file once its terminal completes. A report that is empty or has no `## Findings` section is a failed seat: rerun that persona once on `anthropic/claude-opus-5-5` at `high`, and when the rerun fails too, list the seat as failed in the report's Panel line. Verify before you judge. For every `critical` and `warning`, read the cited code yourself. When the finding carries a command or a counterexample, read it, then run it; run anything from a branch you don't trust in a throwaway worktree or container. When it claims a caller can pass a value, trace the caller. A claim that does not reproduce is Dismissed with what you saw. When a finding's suggested fix is out of bounds, such as a CI change the run may not make, keep its risk open and look for a local witness you may run, such as building the deploy artifact, before you downgrade it. Whether the finding is valid, whether its fix is permitted, and whether a witness proves it are three separate judgments.

Then sort each persona's findings into four buckets, using the [lead judgment framework](references/lead-judgment.md):

- **Act on**: a real problem for correctness, security, the spec, or maintainability. It would block a merge.
- **Consider**: legitimate, but not clearly worth the cost now. Name the tradeoff.
- **Noted**: valid and not actionable now.
- **Dismissed**: wrong, out of context, a preference, or not reproduced, with a one-line reason.

Keep the personas separate and leave findings unranked across them, so one lens cannot mask another. When two personas raise the same issue, keep it under the first in table order and note who else raised it: independent agreement is the strongest signal. Credit a persona only for a finding in its own report with the same root cause.

## 7. Report

```markdown
## Review: <branch> against <fixed point>

Intent: <one paragraph, marked inferred when there was no spec>
Panel: <persona: model> for each persona run. Skipped: <persona: reason>

### <Persona>
**Act on**: <finding, location, evidence, how you verified it>
**Consider**: ...
**Noted**: ...
**Dismissed**: ...

(one section per persona, in table order)

Summary: <Act on count per persona, and the worst finding within each persona>
```

Save the report as `report.md` in the review's folder, beside the persona reports it judged, and show it to the user. Changes wait for the user.
