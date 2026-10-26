# Definition of Done

Every implementer and fixer unit meets this bar on top of its ACCEPTANCE, and the verifier grades both.

- Its worktree is based on the integration branch before work starts, reset onto it if not.
- Names in code, routes, fields, tests, commits, and PR text follow `plan.md`'s Terms and the contract notes. A new term the unit owns goes into the glossary per the **domain-modeling** skill. No ADR is contradicted unless the brief says the user reopened it.
- It works test-first per the **tdd** skill wherever the ticket has a cheap test target, at the seams the contract notes name, one slice at a time. The receipt holds the tdd report.
- A chain unit implements its tickets in order, one commit per ticket named by the ticket's title, and passes each ticket's checks before it starts the next.
- It dogfoods the change per the **principle-prove-it-works** skill's "Dogfood the real thing" section, through the verification skill the orders name, whether or not the ticket had a cheap test target. The receipt holds that section's report.
- The repository's checks for the touched paths pass on the committed head. A check reruns only after the code changed since its last pass.
- It changes only what the ticket needs. Anything else worth fixing goes in REPORT as a follow-up.
- Ticket keys stay out of its branch name, commit messages, PR title, and PR body, which name each ticket by its title, because the tracker moves any ticket a merged or closed PR names, whatever its base.
- It merges the integration branch tip into its own branch before reporting done, so the squash merge carries its verdict (same tree).
- Its intermediate PR targets the integration branch and is ready, not draft. The body is a receipt for the lead: each ticket's title, what changed, and what ran.
