# One Execution Ceiling for every Delegate Effort

Delegate Runs used to carry effort-scaled budgets — a fast run died at 8 minutes, a thorough one at 60 — plus a soft convergence message that told the child to wrap up. Because `effort` is described to the parent as reasoning depth, parents sized tasks by complexity and lost whole waves of children to a wall-clock limit they had no reason to expect. We replaced the four budgets with one Execution Ceiling, 60 minutes or 60,000,000 reported tokens at every effort, and deleted the soft convergence path with it.

## Consequences

`effort` now selects the child's thinking level and nothing else, and the ceiling is stated in the `delegate_run` description so it is visible where tasks are sized. Nothing warns a child as it approaches the ceiling; instead every abnormal settle hands the parent a Termination Checkpoint — the child's last messages and tool calls — so a killed run can be re-briefed from what it was doing rather than reverse-engineered from its diff. A genuinely runaway child now burns up to an hour before it stops, which we accept as the price of never truncating useful work.
