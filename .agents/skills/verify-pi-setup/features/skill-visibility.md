# Skill visibility

Skill visibility lets a user choose which loaded skills the model can discover, by toggling `disable-model-invocation` in each skill's `SKILL.md`. Skills marked `user-invokable: false` also drop out of `/skill:` autocomplete, though typing the full command still runs them.

## Sub-features

- `visibility-list` lists every user-invokable skill as `● <name> — discoverable` or `○ <name> — hidden`, followed by `Done`.
- `visibility-toggle` flips one skill, announces it, and rewrites its `SKILL.md` frontmatter.
- `visibility-reload` reloads resources when the dialog closes after a change.
- `visibility-autocomplete` hides `user-invokable: false` skills from `/skill:` suggestions.

## How to get to it (user POV)

- Type `/skill-visibility` and press Enter, then move with the arrow keys and press Enter on a skill.
- Type `/skill:` followed by part of a skill name and read the suggestion list.

## Driving it with control-pi

Preconditions:

- A fresh launch passed doctor.
- `grep -c 'disable-model-invocation: true' "$($CP path RUN agent)/skills/architect/SKILL.md"` prints `1`. Every pstack skill starts hidden, as upstream ships it.

- **Open the list.** Run `$CP send RUN /skill-visibility` and `$CP wait RUN 'architect — hidden' 10`. The list is taller than the pane, so `Done` is offscreen. The dialog `Skill visibility` opens with `→ ○ architect — hidden` selected. Skills this setup adds, such as `dumpfile` and `mailbox`, show `● … — discoverable`. Snap it.
- **Expose a skill.** Run `$CP keys RUN Enter` and `$CP wait RUN 'architect is now model-discoverable' 10`. The selected row now reads `→ ● architect — discoverable`.
- **Close and reload.** Run `$CP keys RUN Escape` and `$CP wait RUN 'Reloaded keybindings, extensions, skills' 10`. The notice `Reloading skills.` comes first.
- **Side effect.** Run `grep -n disable-model-invocation "$($CP path RUN agent)/skills/architect/SKILL.md"`. It prints `disable-model-invocation: false` inside the frontmatter. `git status --short agent/skills` in the checkout prints nothing.
- **Hidden autocomplete.** Run `$CP keys RUN -l '/skill:pi-har'`. No suggestion list appears, because `pi-harness` is `user-invokable: false`. Run `$CP keys RUN C-u`.
- **Visible autocomplete.** Run `$CP keys RUN -l '/skill:recal'`. The list shows `→ skill:recall` with its description. Run `$CP keys RUN C-u`.
- **Proof.** Snap after each step, and copy the scratch `architect/SKILL.md` into the evidence directory.

## Gotchas

- The extension writes the `SKILL.md` of whichever skill it toggles, wherever that file lives. `control-pi` loads only the scratch copies, so never launch Pi for this recipe any other way.
- Making a skill discoverable writes `disable-model-invocation: false` instead of removing the line. A round trip on a skill that had no line does not restore the original bytes.
- The dialog lists only user-invokable skills, so `pi-harness`, `engineering-standards`, and the other `user-invokable: false` skills are absent from it.
- Closing the dialog without a change does not reload.
