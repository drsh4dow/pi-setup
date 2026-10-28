# Router

General mode's system prompt, `agent/SYSTEM.md`, routes each task through the `<router>` table to one skill, named by path. The model reads that skill and opens its reply with the skill's steps as its todolist, each skipped step marked with its reason. A task that matches no row gets a reply that opens with `No workflow matched.`. Only principle skills and `unslop` appear in the model's skill table. The model reads every other skill by path, and the hidden skills that `docs/inventory.md` lists as **you** also load by hand with `/skill:<name>`.

## Sub-features

- `router-route` routes a request for a spec to `to-spec` and lists its steps as the todolist.
- `router-no-match` answers a task no row covers under the core rules and says that no workflow matched.
- `router-table` keeps the model's skill table to principle skills and `unslop`.
- `router-by-hand` keeps `/skill:to-spec` in autocomplete and loads it.

## How to get to it (user POV)

- Send any prompt in a new session. The router applies to the first reply.
- Type `/skill:` followed by part of a skill name, then send the full command.

## Driving it with control-pi

Preconditions: a fresh launch per recipe, from a checkout that passed `vp install`. Every prompt names the tools it allows, and the spec prompt forbids publishing.

- **Skill table.** Run `$CP launch router-spec` and `$CP doctor router-spec`. Read the session's recorded system prompt after the first turn (below): its `<available_skills>` block lists only `principle-*` skills and `unslop`, and it holds `<router>` with no `<skill_workflow>`.
- **Route a spec request.** Snap `router-spec.before`. Run `$CP send router-spec 'Write a spec of what we discussed: a CLI, wx <city>, that prints today'"'"'s weather. Stop before publishing it anywhere and run no gh command.'`, then `$CP wait-turn router-spec 300`. Snap `router-spec.after`. Proof, read from the newest file under `$($CP path router-spec sessions)`:
  - a `read` tool call on `~/.pi/agent/skills/to-spec/SKILL.md` before any other skill read;
  - the assistant reply opens with a todolist whose lines are to-spec's steps, and each skipped step, such as publishing, carries `skipped:` and a reason;
  - no `bash` call runs `gh`.
- **No matching workflow.** Run `$CP stop router-spec`, `$CP launch router-open`, and `$CP doctor router-open`. Run `$CP send router-open 'In one paragraph, is a four-day work week good for small software teams? Use no tools.'`, then `$CP wait-turn router-open 180`. Snap `router-open.after`. The reply opens with `No workflow matched.` and answers the question, and the session file shows no skill read.
- **Autocomplete by hand.** Run `$CP keys router-open -l '/skill:to-s'` and `$CP wait router-open 'skill:to-spec' 10`. Snap `router-by-hand.autocomplete`. Run `$CP keys router-open C-u`.
- **Load by hand.** Run `$CP send router-open '/skill:to-spec Reply only with the word loaded, and run no tools.'`, then `$CP wait-turn router-open 120`. Snap `router-by-hand.load`. The session file's newest user message holds the `<skill name="to-spec"` block, and the reply is `loaded`.
- Run `$CP stop router-open`.

## Gotchas

- The router's paths point at `~/.pi/agent/skills`, the live checkout, not the scratch copy. The drive proves which skill the model chose; the branch's skill text is read from the checkout under test only through `/skill:`.
- The scratch workspace has no `docs/agents/issue-tracker.md`, so `to-spec` stops before its publish step. Keep the prompt's ban on publishing anyway, and press `$CP keys RUN Escape` if a `gh` call shows on screen.
- `$CP send` of a prompt that starts no turn, such as a partial `/skill:` typed with `keys -l`, needs `$CP wait` on a string, not `wait-turn`.
- The previous recipe's history changes routing, so the no-match prompt runs in its own launch.
