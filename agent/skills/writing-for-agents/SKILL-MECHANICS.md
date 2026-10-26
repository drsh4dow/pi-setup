# Skill mechanics

The skill-specific branch of [`writing-for-agents`](SKILL.md): what changes when the document is a skill (frontmatter, the invocation choice, router skills, and adapting outside skills). Everything else about writing it is the universal reference in `SKILL.md`.

## Invocation

Two choices, trading the two loads:

- A **model-invoked** skill keeps a `description`, so the agent can fire it autonomously, and other skills can reach it. You can still type its name: model-invocation always _includes_ user reach; a description only ever adds agent discovery, never removes the human's. The description is the skill's top-level context pointer, forced to stay loaded at all times: permanent context load in exchange for discoverability. A model-invoked skill whose content is all reference is also one home for shared reference: another skill can invoke it, so reference needed by several skills lives in one place. Mechanics: set `disable-model-invocation: false`, and write a model-facing description carrying the trigger branches (the pointer-writing rules in `SKILL.md` apply in full).
- A **user-invoked** skill strips the description from the agent's reach: only the human typing its name can invoke it by name. Zero context load, but it spends cognitive load: you are the index that must remember it exists. Mechanics: set `disable-model-invocation: true` and `user-invokable: true`; the `description` becomes human-facing: a one-line summary, trigger lists stripped.

Pick model-invocation only when the agent must reach the skill on its own. If it only ever fires by hand, make it user-invoked and pay no context load.

Visibility is user configuration and changes per setup, so never rely on a skill being listed. When one skill depends on another, link the dependency by relative path, such as `[unslop](../unslop/SKILL.md)`. The agent reads the file at that path whether the skill is listed, hidden, or user-invoked, so shared reference can live in any skill or in a plain file outside the skill system.

Every skill in `agent/skills` states both flags, `disable-model-invocation` and `user-invokable`, so a reader sees who can start it without knowing the defaults. `user-invokable: false` keeps a model-invoked skill out of `/skill:` autocomplete; set it when only the agent should start the skill.

## Splitting by invocation

The invocation cut of splitting (the sequence cut lives in `SKILL.md`): split off a model-invoked skill when you have a distinct leading word that should trigger it on its own (a trigger word you actually use in your prompts), or another skill must reach it. You pay context load for the new always-loaded description, so that independent reach has to be worth it.

## Router skills

When user-invoked skills multiply past what you can remember, that piled-up cognitive load is cured by a **router skill**: one user-invoked skill that names the others and when to reach for each, so the human has one skill to remember instead of many. Link each skill it names by relative path to its `SKILL.md`, so the agent can read the one that fits even though none has a description.

## Adapting outside skills

When a skill or rule comes from another author's collection, adapt it into this harness instead of vendoring it:

- Drop upstream pins, commit hashes, and sync dates, since the adapted copy tracks no upstream.
- Strip the author's personal conventions, such as their labels, folders, tools, and tracker habits, and route each step through the skills and records this harness already has.
- Keep the guidance you adopt verbatim, and check each copied span against the source mechanically. Where the host forces a rewrite, compare the rewritten rule with its source for who must do what, to what, and in what scope. Connective words such as "not", "only", and "the caller, not the callee" carry the rule, and a quote check passes over them.
