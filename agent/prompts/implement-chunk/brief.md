# implement-chunk: brief template, role variants, ledger outcomes

Reference for the `/implement-chunk` prompt. Pi loads only the direct `.md` children of a prompts directory as commands, so this file is not a command.

## The template

Every field ends filled, or reads `none` with the reason. Size the brief to the unit: a one-command unit collapses the template to a paragraph that still names the goal, the scope, the verify command, and the report shape.

```
GOAL         one sentence, the outcome, executable by a stranger with no chat access
KIND         owner or delegate
SCOPE        paths this unit may write; paths it may not; its exclusive worktree or branch
AUTHORITY    DECIDE AND REPORT: edits the change forces (a CHANGELOG entry the repo requires,
             tests that pin the changed code, build or bundler config), resolving bot threads
             the bot marked fixed, opening the PR so CI runs a gate the local host cannot
             finish, the repo's fallback merge method. STOP ON: any other write outside SCOPE,
             a product call, an irreversible action. Tailor both lists to the unit.
CONTEXT      pointers to tickets, spec, notes, files, and PRs; upstream reports pasted in full
             when this unit depends on them, because workers cannot see siblings. Tag each
             fact with its source, as orders.md tags its lines
SKILLS       the skills the work requires, by name
ACCEPTANCE   checkable criteria, one per line
VERIFY       exact commands or the control-skill path, plus known gotchas. Run any gate
             longer than about a minute through bg_start, redirected to
             evidence/<unit>/<gate>.log, so a tool timeout cannot take its output with it
TIMEBOX      rough cap on runtime; on expiry, return partial findings and stop rather than run on
FORBIDDEN    no PR retargets or merges, no rebase, no force-push, no fixes outside scope,
             plus unit-specific bans. Each line gives its reason and the alternative it
             allows, such as "no local integration suite: the host is saturated; run it in CI".
             A brief that overrides an order says "lifts order N"
REPORT       status, branch, head SHA, PRs, verdict, what you actually ran, deviations,
             suggested follow-ups. Before stopping for any reason, push the branch or save
             the patch and logs under evidence/<unit>/, and cite that path
STANDING     <orders.md pasted verbatim>
```

## Role variants

The implementer, babysitter, explorer, and live verifier use the template as written. The other roles change these fields and keep the rest.

- **Merger.** VERIFY becomes STEPS: the numbered commands it runs, such as `gh pr merge <n> --<method> --match-head-commit <sha>`, each with the output that shows it worked. ACCEPTANCE is the end state: the branch tip SHA and each PR's state. SKILLS is `none` unless a conflict needs code judgment. FORBIDDEN lifts, by name, the merges, rebases, and retargets its job needs.
- **Verifier.** GOAL is a verdict for PR `#<n>` at head `<sha>`. SCOPE writes nothing in the repository, only `evidence/<unit>/` and its own scratch worktree. VERIFY lists the lanes, each naming the artifact the deploy builds, its runtime, and the input that reaches the changed path, plus the regression lane at base and head. ACCEPTANCE is one ledger outcome per lane. REPORT gives each lane's outcome and its witness paths.
- **PR writer.** SKILLS is **writing-good-prs**. VERIFY is `check-body.ts` exiting 0 on the body file. ACCEPTANCE is the body step 5.3 describes. REPORT gives the PR URL, the body file path, the check output, and the expert read it hands back for you to schedule.
- **Persona.** The **code-review** skill's step 5 writes the assignment. Add STANDING, and pass the settled decisions as that step's contract says.

## Ledger outcomes

Label each `ledger.tsv` row with exactly one of these. Any other label is wrong.

| Outcome                     | Means                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------- |
| `live-deployed-verified`    | Passed on the deployed environment.                                                                      |
| `live-ui-verified`          | Passed by driving the change in a running UI outside the deployed environment.                           |
| `unit-test-verified`        | Passed by tests that reach the changed path.                                                             |
| `type-check-only`           | Only the type check ran. Behavioral work needs better than this.                                         |
| `not-applicable`            | The lane has nothing to witness in this change, such as a behavior lane on a lock-only diff. Give why.   |
| `fails-identically-at-base` | The check fails the same way at base, so the diff did not cause it. Cite both runs and file a follow-up. |
| `accepted-gap`              | A check that cannot run, accepted by a `decisions.md` entry the row cites.                               |
| `isolated-pass-flake`       | Fails in the full run, passes alone. Cite the isolated command and its output.                           |
| `verifier-blocked`          | The verifier could not reach a verdict. Not a pass: respawn when the environment heals.                  |
| `verifier-failed`           | Failed. It gets a fix unit, not a re-verify.                                                             |
| `live-failed`               | Failed on the deployed environment.                                                                      |

A worker may self-report a row. A verifier's row overrides it on the same key.
