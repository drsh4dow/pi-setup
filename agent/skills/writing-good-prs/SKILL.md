---
name: writing-good-prs
description: Use before writing a PR.
user-invokable: false
---

# Writing Good PRs

A good PR should be focused on explaining the reviewer the whole context of Why we implemented the PR, an overall view of how we did it, and supporting material that facilitates the consumption of such PR.
To write a good PR start by loading the unslop skill if not already in context.

## The general Shape of a good PR

### Title

The title should contain the action verb of the task such as feat(CI), fix(voice pipeline), etc. And the issue that this PR address, for example: "fix(mobile): publish missed updates after native builds finish"

### Body

The body should start explaining what the problem was and why this was created, sometimes is a new feature, but even so, this should address the why in a concise manner.
Then the PR should contain the explanation of the new behavior the changes introduce and a short how after that.

Any complementary material such as videos, pictures, etc should be attached here using the dumpfile skill.
Any referenced issue should be referenced at the end of the body with their respective magic keyword such as closes #<issue number>.
