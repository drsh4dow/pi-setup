### Authoring or modifying a skill

**You own the skill's voice.**

1. Use the **writing-for-agents** skill.
2. Validate the skill: frontmatter has `name` and `description`, referenced files exist, cross-skill links resolve.
3. On an edit to an existing file, list every rule the edit removes or weakens, each with its reason. Find them with `git diff --word-diff <base> -- <file>` and read each changed sentence for a rule it no longer states. A rule moved to another file counts as kept only when you name the file. Restore any rule you can't give a reason for removing.
4. Test cases if structural. Skip if subjective.
5. Run **Opening a PR**. The removed-rules list goes in the PR description.

When in doubt, delete. Keep only prose that changes a decision. Tell it to do the thing and skip the reason. Explain only when the rule is confusing without one. Match tone to scope. Point at structural sources (types, READMEs, config) per the **encode-lessons-in-structure** principle skill. Delegate to other skills by path. Don't restate. A workflow you keep hitting but isn't captured → propose a new skill.

**Reply:** summary of the skill, key design decisions, validation notes, and the removed-rules list.
