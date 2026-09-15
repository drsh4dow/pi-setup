---
description: Beautify dirty worktree
---

We have been working on the active worktree, I want you to check if the code produced is beautiful, simple, elegant. I want you to audit the current code changes, and propose a way to make them beautiful if not. Start by understanding the behavior we are trying to achieve with the changes, the product output, that is the only constraint for the proposal.

Beautiful code is code that is readable on a single seam, code that is simple, that doesn't use unnecessary abstractions, getters, setters or scattered constants when they are used a single time. Code that uses few strategic tests. Code that blends perfectly on the current patterns and standards of the repo. Code that is pleasant to read. Code that produces a git diff with more deletions than additions, this is one of the strongest beauty representations.
After you audit the code present me your findings and a plan to address it, the plan might include necessary modifications outside the dirty worktree, which is ok if justified and aligns with beautiful elegant code, however your proposed modifications should never alter behavior.
