# Modes and roles are separate system prompts built from one core

Every session, coordinator, and subagent runs on one `agent/SYSTEM.md`, and a subagent gets its differences as files appended after it, some of which tell it to ignore parts of the prompt above. We decided that each mode and each role gets its own system prompt, built by `scripts/generate-prompts.ts` from one core part plus that mode's or role's parts, all in `agent/system/`. Each prompt then holds only the rules its agent runs under, and the core stays the same in all of them.

## Considered options

- **One prompt patched by appends.** This is the current design. An append can only add text, so a subagent read general mode's rules for involving a human and then read an override telling it to ignore them. Every append also costs context on every turn.
- **A hand-written copy of the core in each prompt.** Nothing keeps the copies equal, and the shared rules drift apart.
- **Composing the prompt when a session starts.** Pi reads `agent/SYSTEM.md` from disk, and so do the evals, so a prompt that exists only at run time cannot be read, diffed, or checked in CI.

## Consequences

The generated prompts, `agent/SYSTEM.md` and everything under `agent/system/generated/`, are committed build output. Edit the parts and run `vp run generate:prompts`. `vp run verify` fails on a prompt that differs from its build and names the parts to edit. On a rebase conflict in a generated prompt, regenerate it rather than merging it by hand.
