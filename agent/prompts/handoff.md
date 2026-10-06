---
name: handoff
description: Compact the current conversation into a handoff message for another agent to pick up.
argument-hint: "What will the next session be used for?"
---

Write a handoff that lets a fresh agent continue this work without reading the
conversation. Your entire reply is the handoff: the user copies it with `/copy`
and pastes it into a new session, so leave out any preamble or closing remarks.

Address the fresh agent directly. Include a "Suggested skills" section naming
the skills it should invoke.

Reference specs, plans, ADRs, issues, commits, and diffs by path or URL rather
than restating their content.

Redact secrets such as API keys and passwords, and personally identifiable
information.

If the user passed arguments, treat them as the focus of the next session and
tailor the handoff to it.

<argument>
  $ARGUMENTS
</argument>
