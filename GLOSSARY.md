# pi-setup

The global configuration of the Pi coding-agent harness: the system prompt, extensions, skills, and evals that shape how every Pi session behaves.

## Language

### Harness building blocks

**Skill**:
A packaged procedure or principle that Pi offers the agent by its description, or that the agent reaches by path when it is a library skill.
_Avoid_: prompt, playbook

**Principle skill**:
A skill named `principle-*` that shapes how the agent thinks rather than giving it steps.
_Avoid_: principle (alone)

**Extension**:
A TypeScript module Pi loads to add tools, commands, or behavior to the harness itself.

**Eval**:
A scenario that runs Pi under this setup and grades what the agent did.
_Avoid_: test, check

### Modes and prompts

**Mode**:
The system prompt a top-level session runs on: general mode by default, or sh4dow mode for a session started with `/sh4dow`.
_Avoid_: mode (alone) for Fast mode or a skill's mode

**Core**:
The rules that every mode and every role prompt share, kept in one source.

**Role prompt**:
The system prompt a subagent runs on: the core, the text every subagent shares, its kind's text, and its role's text.

**Router**:
The table in general mode's prompt that names, for each kind of task, the skill that owns it.

**Library skill**:
A skill hidden from the model's skill table and reached by path from the router, another skill, a role prompt, or a mode.

### Subagents

**Subagent**:
A separate Pi process that receives one assignment from its parent and returns one report.
_Avoid_: child, worker

**Delegate**:
The default kind of subagent: a leaf that does one piece of its parent's step and launches nothing.

**Owner**:
The kind of subagent that carries a whole unit of work, such as a PR, and launches delegates of its own.
_Avoid_: owner for the session that owns a background terminal; say owning session

**Role**:
The named job a subagent is launched for, which fixes its model, thinking level, and role prompt. A role with several models is a panel.
_Avoid_: kind, which is delegate or owner

**Background terminal**:
A command that runs alongside the session that started it, wakes that session when it finishes, and ends with it.
_Avoid_: background task, watcher

### sh4dow runs

**Coordinator**:
The agent in a sh4dow-mode session that owns a chunk: it plans, launches subagents, and merges, but writes no code.
_Avoid_: lead; root, which is the tree position at depth 0

### Records

**State folder**:
The per-project directory outside the repository that keeps what later sessions reuse, such as research, reviews, and eval runs.
_Avoid_: runtime state

**Risk call**:
A verifier's judgment that a PR is low, medium, or high risk, with a one-line reason, stored in its verdict's ledger row: the risk columns on a sh4dow run, the evidence text on an implement-chunk run.
_Avoid_: risk score, severity

**Sample**:
The short read a finished chunk hands the user: the riskiest diffs, the overruled verdicts, and the Attention flags.
_Avoid_: summary, digest

**Config record**:
The committed facts a repository gives the engineering skills: its issue tracker, domain docs, and standards.
_Avoid_: tracker record
