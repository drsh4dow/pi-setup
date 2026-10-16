### Autopilot-stack

**You own the stack, never the landing. Hand the operator one linear stack of base-chained PRs to review and land.** **Autopilot-full** holds except for how verified work leaves. Each tick re-reads both playbooks from trunk, and this one wins where they differ.

1. **Run Autopilot-full's per-PR loop, minus the landing.** A verified PR is STACK-READY in place of merge-ready. Nobody merges, closes a PR, or arms auto-merge, because the operator owns the landing. When an item depends on another, its code delegate branches from that item's branch, not from trunk.
2. **Give the topology one writer.** Code delegates push only their own branch, never rebase it onto another branch, trunk included, and report its tip and intended parent. Only you rebase or retarget a link, because two writers on one chain undo each other. Append each clean PR in dependency order, with its base set to its parent's branch (`origin pr edit <pr> --base <parent-branch>` or `gh pr edit <pr> --base <parent-branch>`). Never require `gt`. A later delegate on a link takes your push as its new base and lease, and on a conflict a delegate resolves that link's slice for you to push.
3. **Absorb drift at the root.** Until landing starts, apply Autopilot-full step 5's test to each link and rebase the chain bottom-up where it calls for one. Then apply the patch-id rule link by link, since a link's base is its parent.
4. **Deliver the chain, then keep your hands off it.** Each link carries its verdict in its PR. Once landing starts, nobody writes to the chain except the post-merge retarget that `playbooks/shipping.md` sanctions, because a second writer breaks a landing in flight. A mid-landing problem goes through you to the operator, and any fix waits for the operator's go.

**Choosing between the autopilots.** Autopilot-stack is the default for an approved multi-PR build, because merging belongs to the operator. Autopilot-full only when the operator grants landing authority and the PRs are independent.

**Reply:** catch the operator up per the **ketchup** skill, with links to the stack root and tip, a one-line verdict per link, and anything parked or excluded with the reason.
