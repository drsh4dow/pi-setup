# pi-setup

The global configuration of the Pi coding-agent harness: the system prompt, extensions, skills, and evals that shape how every Pi session behaves.

## Language

### Harness building blocks

**Skill**:
A packaged procedure or principle that Pi offers the agent, loaded when its description matches the task.
_Avoid_: prompt, playbook

**Principle skill**:
A skill named `principle-*` that shapes how the agent thinks rather than giving it steps.
_Avoid_: principle (alone)

**Extension**:
A TypeScript module Pi loads to add tools, commands, or behavior to the harness itself.

**Eval**:
A scenario that runs Pi under this setup and grades what the agent did.
_Avoid_: test, check

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
The named job a subagent is launched for, which fixes its model and thinking level. A role with several models is a panel.
_Avoid_: kind, which is delegate or owner

**Background terminal**:
A command that runs alongside the session that started it, wakes that session when it finishes, and ends with it.
_Avoid_: background task, watcher

### Records

**State folder**:
The per-project directory outside the repository that keeps what later sessions reuse, such as research, reviews, and eval runs.
_Avoid_: runtime state

**Config record**:
The committed facts a repository gives the engineering skills: its issue tracker, domain docs, and standards.
_Avoid_: tracker record
