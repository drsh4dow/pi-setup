---
name: writing-good-prs
description: Write or update a pull request description with the context a reviewer needs.
user-invokable: false
---

# Writing good PRs

Follow repository title and template conventions. Use a specific title that describes the change.

Explain the problem, the resulting behavior, and the consequential implementation choices. Keep small PR descriptions small; avoid narrating obvious code or listing unchanged behavior.

Report relevant verification performed and material gaps. Include diagrams only when they explain architecture better than prose, and media when it demonstrates a meaningful user-visible change. Use [dumpfile](../dumpfile/SKILL.md) for authorized public evidence uploads.

Reference related issues. Use closing keywords only when the PR resolves the issue; otherwise use an ordinary reference. When updating a description, preserve valid human context and change only what the implementation made stale.
