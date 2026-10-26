# Briefs for implement-chunk

Fill every field, or write `none` and why. Leave the standing orders out: the launcher appends the current `orders.md` to every spawn and resume, and a brief overrides one only by writing `lifts order N`. A one-command unit fits in one paragraph that opens with `COLLAPSED` and names GOAL, SCOPE, VERIFY, and REPORT.

## The template

```
GOAL        the outcome, in one self-contained sentence
KIND        owner or delegate
SCOPE       the paths it writes, its own worktree and branch, and the branch it is based on
AUTHORITY   DECIDE AND REPORT: knock-on edits outside SCOPE (a required CHANGELOG entry,
            tests pinning the changed code, build config), resolving threads the bot marked
            fixed, opening the PR early for CI-only gates, the repo's fallback merge method.
            STOP ON: other writes outside SCOPE, product calls, irreversible actions.
            Tailor both lists to the unit
CONTEXT     pointers to the tickets, spec, Terms, contract notes, files, and PRs, each fact
            tagged with its source as in orders.md. Paste each upstream report in full,
            since a subagent never sees its siblings
SKILLS      by name
ACCEPTANCE  each Done-when item verbatim with its check, grouped by ticket for a chain.
            Implementers add "the Definition of Done"
VERIFY      exact commands or the verification skill, with known gotchas. A gate over a
            minute runs through bg_start into evidence/<unit>/<gate>.log, so a timeout
            keeps the log
TIMEBOX     the runtime cap. At expiry, stop and report what you have
FORBIDDEN   retargets, merges, rebases, force-pushes, and the unit's own bans, each with
            its reason and the path it leaves open: "no local integration suite: the host
            is saturated; run it in CI"
REPORT      status, branch, head SHA, PRs, verdict, commands run, deviations, follow-ups.
            Before stopping for any reason, push the branch or save the patch and logs to
            evidence/<unit>/, and cite the path
```

## Role variants

Roles not listed here use the template as written.

- **Merger.** STEPS replaces VERIFY: numbered commands, such as `gh pr merge <n> --<method> --match-head-commit <sha>`, each with the output that proves it worked. ACCEPTANCE is the end state, the branch tip SHA and each PR's state. SKILLS is `none` unless a conflict needs code judgment. FORBIDDEN lifts by name the merges, rebases, and retargets the job needs.
- **Verifier.** GOAL is a verdict for PR `#<n>` at head `<sha>`. SCOPE is `evidence/<unit>/` and a scratch worktree, nothing in the repository. CONTEXT is the artifact and the contract, never the journey: the tickets, Terms, contract notes, Definition of Done, and diff ref, plus only the commands the implementer ran. A verifier handed a claim validates it. VERIFY lists the lanes, each with its witness spelled out, plus the regression lane at base and head. ACCEPTANCE is one ledger outcome per lane and a pass or finding for each Done-when item and Definition of Done line. REPORT gives each lane's outcome and witness paths.
- **PR writer.** Runs twice, per step 5.3: a drafter writes the body to a file, and a fresh writer opens the PR. SKILLS is **writing-good-prs**. VERIFY is `check-body.ts` exiting 0 on the body file. ACCEPTANCE is a body a cold reader can trust: the integration head's change against its base, the verdict's witnesses pasted in, `Closes` for each ticket it finishes, and `Part of` for the rest. It cites another final PR by number and purpose, since `plan.md`'s letters and branches mean nothing to a reviewer. REPORT gives the PR URL, the body file, the check output, and the expert read for you to schedule.
- **Persona.** The **code-review** skill's step 5 writes the assignment. Launch it with `--orders`, and add `plan.md`'s Terms to the contract that step describes.

## Ledger outcomes

Each `ledger.tsv` row takes one of these outcomes.

| Outcome                     | Merge-ready   | Means                                                                                          |
| --------------------------- | ------------- | ---------------------------------------------------------------------------------------------- |
| `live-deployed-verified`    | yes           | Passed on the deployed environment.                                                            |
| `live-ui-verified`          | yes           | Passed by driving a running UI outside the deployed environment.                               |
| `unit-test-verified`        | yes           | Passed tests that reach the changed path.                                                      |
| `type-check-only`           | lead sign-off | Only the type check ran, which is too weak for a behavior change.                              |
| `not-applicable`            | if cited      | The lane has nothing to witness, such as a behavior lane on a lockfile-only diff.              |
| `fails-identically-at-base` | if cited      | Fails the same way at base, so the diff is not the cause. Cite both runs and file a follow-up. |
| `accepted-gap`              | if cited      | Cannot run, and a `decisions.md` entry accepts the gap.                                        |
| `isolated-pass-flake`       | if cited      | Fails in the full run and passes alone. Cite the isolated run.                                 |
| `verifier-blocked`          | no            | No verdict reached. Respawn when the environment heals.                                        |
| `verifier-failed`           | no            | Failed. The next unit is a fix, not a re-verify.                                               |
| `live-failed`               | no            | Failed on the deployed environment.                                                            |

Implementers may self-report a row, and a verifier's row on the same key overrides it.
