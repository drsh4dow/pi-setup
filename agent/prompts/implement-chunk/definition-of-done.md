# Definition of Done

The implementer meets this bar on top of its brief's ACCEPTANCE, and the verifier grades both.

- Branch from the integration tip. Before reporting, merge the tip back in, so the tree you verified is the tree that squashes in.
- Name everything, in code and in prose, after `plan.md`'s Terms and the contract notes. Add each new term you own to the glossary per the **domain-modeling** skill. Honor every ADR the brief does not mark reopened.
- Work red-green per the **tdd** skill wherever a cheap test target exists, at the seams the contract notes name.
- Dogfood the change through the verification skill the orders name, per the **principle-prove-it-works** skill, even when tests cover it.
- A chain lands one commit per ticket, in ticket order, titled by the ticket. Each ticket goes green before the next starts.
- Keep the diff to what the tickets need, and log anything else worth fixing as a follow-up in REPORT.
- Pass the repository's checks for the touched paths on the committed head. Rerun a check only when the code changed since it passed.
- A scratch-file rule in your orders or brief binds the files you write. A directory a test makes for itself with `mkdtemp` under the system temp dir belongs to the test, so running the test keeps you inside the rule.
- Name tickets by title, never by key, in branch names, commits, and PR text. The tracker moves any ticket a merged or closed PR names, whatever its base.
- Open the intermediate PR ready for review, against the integration branch. Its body is the receipt: each ticket's title, what changed, what ran, and the tdd and dogfood reports.
