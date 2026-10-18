---
name: poteto-help
description: Guides users through pstack in this Pi setup and picking the skill, playbook, or principle for a task. Type /skill:poteto-help with a question.
disable-model-invocation: true
---

# Poteto help

Answer the user's question about pstack, hand them a prompt they can send, and link the file the answer came from. For a help question, don't start the work. The user asked how, and a pstack run spends real tokens, so let them send the prompt.

A message that asks for work, such as "use pstack to fix this bug", is not a help question. Do the work. The system prompt already runs pstack on every task.

This file maps questions to the skills and playbooks that hold the answers. Those files own the details. Read the file you route to before you quote it, and trust it when it disagrees with this map. The links here are relative to this file, so give the user the file's full path, such as `~/.pi/agent/skills/how/SKILL.md`.

## Find out what they need

Infer the need from the message and the conversation. A named situation, such as "which skill reviews a PR?", goes straight to its section. If the need is still unclear, ask one multiple-choice question with these options, then answer only the section they pick:

- Get set up
- Start a task
- Pick a skill for a situation
- Fix a run that went wrong
- Make pstack my own

Check the state that changes the answer, and mention it only when it does:

- No `verify-*` skill or other app harness in the project means agents have no scripted way to drive the app. Mention `/skill:create-verification-skill` when the question is about proving a change works.

## Get set up

There is nothing to install or run first. The system prompt carries pstack's working method into every session, subagents included, and each subagent role takes its model and thinking level from the model table in the [subagents skill](../subagents/SKILL.md). Start a real task with a goal and a check that can pass or fail.

Skills whose frontmatter sets `disable-model-invocation: true` load only when the user types them. The others also load when a task matches their description. The [README's pstack section](../../../README.md#pstack) maps each upstream mechanic to its Pi equivalent and lists what this setup did not port. Offer to word their first prompt with them, per [`references/prompting.md`](references/prompting.md).

If cost is the worry, say where the tokens go and how to spend fewer. pstack spends extra tokens on subagents and review panels. Lower a role's thinking level or pick a cheaper model in its row of the subagents skill's model table. A panel role with fewer models runs fewer subagents, one for each model.

## Start a task

The system prompt matches each task to a playbook, copies the playbook's steps into the todo list, and runs the other skills as the steps need them. A step it skips stays in the list as `skip: <reason>`. A good prompt states the goal and how to tell it's done. It doesn't list skills, because a hand-written sequence tends to drop or reorder steps the playbook would keep. Read [`references/prompting.md`](references/prompting.md) before you help word one. [`references/recipes.md`](references/recipes.md) has examples.

Mid-chat, "new task" makes the mode match a fresh playbook. Every subagent also runs the system prompt, so a subagent of your own gets the same style. The [subagents skill](../subagents/SKILL.md) covers starting one.

## Pick a skill

The default answer is a plain task prompt. The system prompt's playbooks run most skills when their steps need them. Name a skill directly when the user wants more or less of something than the playbook gives. Read the skill before you recommend it, and give one example prompt.

| The user wants to | Skill |
|---|---|
| Do any non-trivial task with rigor | A plain task prompt, run under [`SYSTEM.md`](../../SYSTEM.md) |
| Check that the agent understood their goal and the problem before it starts | [`/skill:in-your-own-words`](../in-your-own-words/SKILL.md) |
| Aim a task higher before starting: more expert, more outcome-focused, not overspecified | [`/skill:sharpen`](../sharpen/SKILL.md) |
| Know how code works now, or where new code should live | [`/skill:how`](../how/SKILL.md) |
| Know why code is shaped this way, or where a number came from | [`/skill:why`](../why/SKILL.md) |
| Understand a change or subsystem, explained plainly | [`/skill:teach`](../teach/SKILL.md) |
| Catch up on their own recent work on a topic | [`/skill:recall`](../recall/SKILL.md) |
| Catch up on what changed in this chat since their last message, in plain words and small visuals, with every item waiting on them listed and decidable from the reply alone | [`/skill:ketchup`](../ketchup/SKILL.md) |
| Know what a small diff could break outside itself | [`/skill:blast-radius`](../blast-radius/SKILL.md) |
| Settle types and module shape before code that crosses a function boundary | [`/skill:architect`](../architect/SKILL.md) |
| Get several attempts at one brief, merged into the best one | [`/skill:arena`](../arena/SKILL.md) |
| Run parallel checks over slices, or race workers, as local subagents | [`/skill:swarm`](../swarm/SKILL.md) |
| Have different models review a diff and try to break it | [`/skill:interrogate`](../interrogate/SKILL.md) |
| Fix a bug test-first when a cheap local test exists | [`/skill:tdd`](../tdd/SKILL.md) |
| Apply TypeScript rules to `.ts` or `.tsx` work | [`/skill:typescript-best-practices`](../typescript-best-practices/SKILL.md) |
| Strip comments before review, using a reviewer that didn't write them | [`/skill:no-comments`](../no-comments/SKILL.md) |
| Clean AI tells out of prose | [`/skill:unslop`](../unslop/SKILL.md) |
| Write docs, an RFC, a README, a PR description, or a commit message to a standard | [`/skill:technical-writing`](../technical-writing/SKILL.md) |
| Hear the last reply again in plain words | [`/skill:bro`](../bro/SKILL.md) |
| Give agents a scripted way to drive the app and prove behavior | [`/skill:create-verification-skill`](../create-verification-skill/SKILL.md) |
| Bring a verification skill and its feature map back in line with the app | [`/skill:maintain-verification-skill`](../maintain-verification-skill/SKILL.md) |
| Formally verify a race, invariant, or other property that tests rarely reach | [`/skill:create-formal-verification-skill`](../create-formal-verification-skill/SKILL.md) |
| Vet a performance number before reporting or acting on it | [`/skill:benchmark-checklist`](../benchmark-checklist/SKILL.md) |
| Run a large or cross-cutting change, or one to review after stepping away | [`/skill:figure-it-out`](../figure-it-out/SKILL.md) |
| Keep a decision log during a run, and review it afterward | [`/skill:show-me-your-work`](../show-me-your-work/SKILL.md) |
| Turn their own working habits into a personal mode skill | [`/skill:automate-me`](../automate-me/SKILL.md) |
| Turn what a finished task taught into skill edits | [`/skill:reflect`](../reflect/SKILL.md) |
| Stop agents from repeating the same mistakes in this repo | [`/skill:correct`](../correct/SKILL.md) |
| Find their way around pstack | `/skill:poteto-help` |

If a skill directory next to this one is missing from the table, read its frontmatter and route by its description. The `principle-*` directories are covered under principles below.

Close calls:

- `/skill:how` explains what the code does. `/skill:why` explains the reasons. `/skill:teach` runs one or both and explains the result plainly.
- `/skill:arena` gives every worker the same brief and merges the best parts. `/skill:swarm` splits work into slices or a race and returns one report.
- `/skill:architect` implements right after it settles the design. Add "with checkpoint" to review the design before it writes code.
- `/skill:interrogate` reviews the diff. `/skill:blast-radius` looks for breakage outside the diff and proves the one fact that makes the change safe.
- `/skill:recall` rebuilds context across recent chats. `/skill:ketchup` covers only this chat since the user's last message. Resuming one specific chat or branch is the Session pickup playbook.
- `/skill:figure-it-out` designs one rigorous run. The Orchestrate playbook runs a program that spans days and many PRs. The Autonomous run playbook drives one task to a finish condition.

Not in pstack:

- `/deslop` is a prompt template in [`agent/prompts/`](../../prompts/deslop.md). The `agent-browser` skill drives UIs, and the [`background-terminals`](../background-terminals/SKILL.md) skill drives CLIs, with tmux for TUIs.
- A background terminal whose completion wakes the agent repeats work until a check passes. The [`writing-for-agents`](../writing-for-agents/SKILL.md) skill covers writing a skill.
- pstack has no `/orchestrate` skill. Orchestrate is a playbook. If the slash menu shows `/orchestrate`, another package or prompt template provides it.

## Playbooks and principles

Playbooks are step lists in `~/.pi/agent/poteto/playbooks/`, not skills, so they have no slash command. Describing the task picks one, and these phrases name one directly:

- "babysit this pr" or "check on pr 123" runs Babysit. It drives the PR to merge-ready and stops there. It doesn't merge unless the user asks to merge, land, or ship.
- "land the stack" runs Shipping.
- "take over this branch" runs Session pickup.
- "pause safely" runs Pause safely.
- "full autopilot on this queue" runs Autopilot-full. "stack them, don't ship" runs Autopilot-stack.
- "run the eval playbook" runs Eval.

The system prompt's Playbooks section lists every playbook and when it applies. The [Opening a PR](../../poteto/playbooks/opening-a-pr.md), [Babysit](../../poteto/playbooks/babysit.md), and [Shipping](../../poteto/playbooks/shipping.md) playbooks cover opening, babysitting, and landing a PR.

pstack has no planning skill. For work that spans phases or stacked PRs, asking for a plan runs the [Multi-phase plan playbook](../../poteto/playbooks/multi-phase-plan.md), which writes the plan and doesn't implement it. For a design question, the Prototype playbook or `/skill:architect` settles it in code first.

Principles are one-rule skills that the agent reads and cites in its replies, as the system prompt directs. The user rarely invokes one. They steer with the names instead, as in "apply prove it works. show me the real output." Typing `/skill:principle-<name>` still loads one on demand. Each lives in a `principle-*` directory next to this one.

## Fix a run that went wrong

| Symptom | Fix |
|---|---|
| A question got treated as the next step of the last task | Say "new task", or say the turn doesn't need the mode. |
| A new model choice had no effect | A session that already read the subagents skill keeps its old model table. Ask the agent to reread the skill, or start a new session with `/new`. |
| Runs cost more than expected | See the cost paragraph under Get set up. |
| A skill didn't load on its own | A skill with `disable-model-invocation: true` loads only when the user types it. The others load when a task matches their description or a playbook step runs them, and the model can miss a match. Type `/skill:<name>` to force one. |
| Parallel agents overwrote each other | Give each agent its own worktree, with its own ports and state. |
| An overnight run moved but finished nothing | The loop needs a check that can pass or fail, not a duration. See the [Autonomous run playbook](../../poteto/playbooks/autonomous-run.md). |
| The reply claims success from a green build | Ask for the real command, flow, stored value, or profile. That's the prove-it-works principle. |

For a run that drifts, [`references/prompting.md`](references/prompting.md) has one-line steers. [`references/recipes.md`](references/recipes.md) has the recipes worth copying.

## Make pstack my own

- [`/skill:automate-me`](../automate-me/SKILL.md) drafts a personal mode skill from the user's own history, to use alongside the system prompt.
- [`/skill:reflect`](../reflect/SKILL.md) after a session turns its lessons into skill edits the user approves.
- `write a skill for <workflow>` runs the authoring playbook. The eval playbook tests a skill change blind.
- Fix a misbehaving skill in its own PR, not inside the feature work where it went wrong.

## Reply

Lead with the answer. Give at most one example prompt in a code block, adapted from [`references/recipes.md`](references/recipes.md) when one fits, then the link to that file. Keep it short unless the user asked for the whole map.
