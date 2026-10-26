# implement-chunk: brief template, Definition of Done, role variants, ledger outcomes

Reference for the `/implement-chunk` prompt. Pi loads only the direct `.md` children of a prompts directory as commands, so this file is not a command.

## The template

Every field ends filled, or reads `none` with the reason. Size the brief to the unit: a one-command unit collapses the template to a paragraph that still names the goal, the scope, the verify command, and the report shape. Start that paragraph with `COLLAPSED` and write GOAL, SCOPE, VERIFY, and REPORT in it, so the launcher checks those four fields.

```
GOAL         one sentence, the outcome, executable by a stranger with no chat access
KIND         owner or delegate
SCOPE        paths this unit may write; paths it may not; its exclusive worktree or branch
AUTHORITY    DECIDE AND REPORT: edits the change forces (a CHANGELOG entry the repo requires,
             tests that pin the changed code, build or bundler config), resolving bot threads
             the bot marked fixed, opening the PR so CI runs a gate the local host cannot
             finish, the repo's fallback merge method. STOP ON: any other write outside SCOPE,
             a product call, an irreversible action. Tailor both lists to the unit.
CONTEXT      pointers to tickets, spec, plan.md's Terms, notes/contract.md, files, and PRs;
             upstream reports pasted in full when this unit depends on them, because a
             subagent cannot see its siblings. Tag each fact with its source, as orders.md
             tags its lines
SKILLS       the skills the work requires, by name
ACCEPTANCE   the ticket's Done-when items verbatim, one per line, each with its check; for an
             implementer or fixer, plus "the Definition of Done"
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
```

The standing orders are not a field. The launch appends `orders.md` as a system prompt, so every spawn and resume reads the current file.

## Definition of Done

Every implementer and fixer unit meets this bar on top of its ACCEPTANCE, and the verifier grades both.

- Its worktree is based on the integration branch before work starts, reset onto it if not.
- Names in code, routes, fields, tests, commits, and PR text follow `plan.md`'s Terms and the contract notes. A new term the unit owns goes into the glossary per the **domain-modeling** skill. No ADR is contradicted unless the brief says the user reopened it.
- It works test-first per the **tdd** skill wherever the ticket has a cheap test target, at the seams the contract notes name, one slice at a time. The receipt holds each slice's red run.
- It dogfoods the change on the real surface: the **agent-browser** skill for browser and Electron UIs, the **background-terminals** skill for CLIs and TUIs, or the repository's `verify-*` skill. "Inconclusive" or wrong-surface is not a pass.
- The repository's checks for the touched paths pass on the committed head. A check reruns only after the code changed since its last pass.
- It changes only what the ticket needs. Anything else worth fixing goes in REPORT as a follow-up.
- Ticket keys stay out of its branch name, commit messages, PR title, and PR body, which name each ticket by its title, because the tracker moves any ticket a merged or closed PR names, whatever its base.
- It merges the integration branch tip into its own branch before reporting done, so the squash merge carries its verdict (same tree).
- Its intermediate PR targets the integration branch and is ready, not draft. The body is a receipt for the lead: the ticket title, what changed, and what ran.

## Role variants

The implementer, babysitter, explorer, and live verifier use the template as written. The other roles change these fields and keep the rest.

- **Merger.** VERIFY becomes STEPS: the numbered commands it runs, such as `gh pr merge <n> --<method> --match-head-commit <sha>`, each with the output that shows it worked. ACCEPTANCE is the end state: the branch tip SHA and each PR's state. SKILLS is `none` unless a conflict needs code judgment. FORBIDDEN lifts, by name, the merges, rebases, and retargets its job needs.
- **Verifier.** GOAL is a verdict for PR `#<n>` at head `<sha>`. SCOPE writes nothing in the repository, only `evidence/<unit>/` and its own scratch worktree. CONTEXT is the artifact and the contract: the tickets, the Terms, the contract notes, the Definition of Done, and the diff ref. From the implementer's report it takes only the commands that ran. Leave out the implementer's conclusions and your own expectations, because a verifier handed a claim returns validation of it. VERIFY lists the lanes, each naming the artifact the deploy builds, its runtime, and the input that reaches the changed path, plus the regression lane at base and head. ACCEPTANCE is one ledger outcome per lane, and a pass or a finding for each Done-when item and each Definition of Done line. REPORT gives each lane's outcome and its witness paths.
- **PR writer.** A drafting writer writes the body to a file and opens nothing; the writer that opens the PR applies the expert read and pastes the verdict's witnesses. SKILLS is **writing-good-prs**. VERIFY is `check-body.ts` exiting 0 on the body file. ACCEPTANCE is a body for a reviewer who never saw this run: the change at the integration head against its base, the evidence behind that head's verdict pasted as witnesses, a `Closes` line for each ticket it finishes, and a `Part of` line for each other ticket. It names another final PR by its number and what it does, never by its letter or branch in `plan.md`. The intermediate merges already link each intermediate PR. REPORT gives the PR URL, the body file path, the check output, and the expert read it hands back for you to schedule.
- **Persona.** The **code-review** skill's step 5 writes the assignment. Append `orders.md` to the launch, and pass the Terms and the settled decisions as that step's contract says.

## Ledger outcomes

Label each `ledger.tsv` row with exactly one of these. Any other label is wrong.

| Outcome                     | Merge-ready   | Means                                                                                                    |
| --------------------------- | ------------- | -------------------------------------------------------------------------------------------------------- |
| `live-deployed-verified`    | yes           | Passed on the deployed environment.                                                                      |
| `live-ui-verified`          | yes           | Passed by driving the change in a running UI outside the deployed environment.                           |
| `unit-test-verified`        | yes           | Passed by tests that reach the changed path.                                                             |
| `type-check-only`           | lead sign-off | Only the type check ran. Behavioral work needs better than this.                                         |
| `not-applicable`            | if cited      | The lane has nothing to witness in this change, such as a behavior lane on a lock-only diff. Give why.   |
| `fails-identically-at-base` | if cited      | The check fails the same way at base, so the diff did not cause it. Cite both runs and file a follow-up. |
| `accepted-gap`              | if cited      | A check that cannot run, accepted by a `decisions.md` entry the row cites.                               |
| `isolated-pass-flake`       | if cited      | Fails in the full run, passes alone. Cite the isolated command and its output.                           |
| `verifier-blocked`          | no            | The verifier could not reach a verdict. Not a pass: respawn when the environment heals.                  |
| `verifier-failed`           | no            | Failed. It gets a fix unit, not a re-verify.                                                             |
| `live-failed`               | no            | Failed on the deployed environment.                                                                      |

An implementer may self-report a row. A verifier's row overrides it on the same key.
