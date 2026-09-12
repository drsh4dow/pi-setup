---
name: writing-for-agents
description: Write or edit agent instructions, skills, AGENTS.md, or CLAUDE.md.
---

# Writing for agents

Keep instructions that change behavior, project-specific constraints, and non-obvious operational knowledge. Delete motivational prose, generic advice, stale history, and facts cheaply available from configuration or `--help`.

## Scope and loading

- State when an instruction applies. A task-specific recipe must not become a prerequisite for unrelated work.
- Make pointers conditional: name the task that needs the linked file or section. Keep common steps inline; disclose branch-specific reference only when needed.
- Keep each rule in one authoritative place. Follow references before editing, then remove obsolete pointers and duplicate rules together.
- Distinguish accepted decisions from proposals, historical evidence, examples, and generated documentation.
- Split a file only when different tasks need different parts. Moving unnecessary prose into another file does not justify keeping it.

## Workflows

- Write ordered actions with observable completion criteria. Keep each gate beside the step it verifies.
- Match verification to the changed behavior. Do not add fixed test counts, mandatory artifacts, or repeated checks without a concrete reason.
- Preserve the user's requested scope and deliverable. User instructions take precedence over skill guidelines; ask only when an unresolved choice materially changes the outcome.
- Prefer explicit target behavior. Keep prohibitions for meaningful boundaries, not lists of imagined mistakes.

## Skills

Give each skill a narrow activity trigger. Use automatic discovery when the agent needs to select it; use explicit invocation for workflows the user chooses. Verify frontmatter and invocation semantics against the actual harness rather than assuming they transfer between tools.

## Review

Check links and commands, reconcile conflicting instructions, and remove rules already enforced by tooling unless the rationale remains useful. For workflow changes, exercise the changed path and report what was actually verified.
